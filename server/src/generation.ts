import { z } from 'zod'
import { chatStructured, type StructuredEmit } from './structured'
import type { LLMConfigRecord } from './llm'
import { guideDaySchema, guideSpotSchema, planOptionsSchema, travelGuideSchema } from '../../shared/types'
import type { GenerationEvent, GuideDay, GuideSpot, PlanOption, TravelGuide } from '../../shared/types'

export type GenerationEmit = (event: Omit<GenerationEvent, 'elapsedMs'>) => void

/** 指南生成所需的只读外部证据：口碑评分、地图定位与用户实采线索均由系统注入，模型只负责归纳 */
export interface GuideContext {
  geo?: string
  /** 用户在小红书实采的线索（非评分），仅作地点/店名/玩法参考 */
  research?: string
  /** 需要生成图文卡的地点名，来自第一阶段的 places */
  places?: string[]
}

const OPTIONS_SYSTEM = `你是资深旅行规划师。根据用户的需求，给出 3 个差异明显的定制方案供用户挑选。
只输出一个 JSON 对象，结构为：
{"options":[{"title":"方案名","theme":"主题","days":"天数","budget":"预算区间","pace":"节奏","highlights":["亮点"],"summary":"方案概述","suitableFor":"适合人群"}],"places":["方案中涉及的具体地点名"],"city":"目的地城市"}
要求：恰好 3 个方案，且在主题、节奏或预算上明显区分；days 用「3 天」这类阿拉伯数字格式；places 列出 3–8 个方案里真实会去到的具体景点、街区或餐厅名称，用于后续核对第三方口碑与地图定位，不要写「成都」「市区」这类宽泛地域，不要编造不存在的地点；city 只写目的地城市的中文名（如「成都」），不要写省份、国家或描述性文字；全部字段使用中文；不要输出解释文字或 Markdown 围栏。`

const GUIDE_META_SYSTEM = `你是资深旅行规划师。用户已经从候选方案中选定了一个，请生成旅游指南的概览部分。
只输出一个 JSON 对象，结构为：
{"title":"指南标题","destination":"目的地","duration":"行程时长","overview":"整体概述","budget":{"level":"预算档位","items":["费用明细"],"total":"合计金额"},"packing":["行前清单"],"notes":["注意事项"]}
要求：不要包含 days 与 spots 字段；overview 用 80–140 字写清行程主线和节奏，简洁有力、不写套话、不堆形容词；budget.items 给 4–5 条具体费用项（短句即可）；packing 与 notes 各 4–5 条、每条一句话的可执行建议；全部中文；金额使用人民币；不要编造具体航班号、酒店名称、门票价格、评分或无法核实的地址；禁止写任何评分、星级或「网友评价」；不要输出解释文字或 Markdown 围栏。`

const GUIDE_DAYS_SYSTEM = `你是资深旅行规划师。请只生成指定天数的每日行程。文字要精简，像一份能照着走的清单，不要长篇大论。
只输出一个 JSON 对象，结构为：
{"days":[{"day":"第1天","title":"当日主题","morning":"上午安排","afternoon":"下午安排","evening":"晚上安排","meals":"餐饮建议","transport":"交通建议","tips":"当日贴士"}]}
要求：
- days 数组只包含本次指定的天数，数量必须精确；day 字段使用「第N天」。
- morning / afternoon / evening 每段 30–60 字，用【具体地点名 + 做什么 + 顺序节奏】的短句，地点名之间用「→」串联；不要写「自由活动」「感受当地文化」这类空话，不要写满 60 字凑数。
- meals 一句话写具体菜品/街区/餐饮类型与时段；transport 一句话定性建议（打车 / 地铁 / 步行，不写线路号与票价）；tips 一句话提醒（预约 / 避峰 / 天气）。
- 若用户消息提供了小红书实采笔记，优先采用笔记里出现的具体店名、街区与玩法，让行程更真实；点赞数是热度不是评分，禁止写「评分高/口碑好」。
- 严格禁止编造经纬度、门牌号、评分、星级、票价与官方开放时间。
- 不要输出解释文字或 Markdown 围栏。`

const GUIDE_SPOTS_SYSTEM = `你是资深旅行编辑，为旅游指南撰写「地点图册」的图文卡文案。每张卡会配地图链接和相关的真实小红书笔记，所以你的文字要短、具体、不重复笔记内容。
只输出一个 JSON 对象，结构为：
{"spots":[{"name":"地点名","category":"类型","day":"第N天","time":"建议时段","stay":"建议停留","intro":"详细介绍","highlights":["亮点"],"tips":"实用贴士","photo":"观景或拍照建议","cost":"费用参考"}]}
要求：
- 只为本次指定的地点生成，每个地点恰好 1 条，数量与顺序必须与给定列表完全一致；name 必须与给定地点名逐字一致。
- category 从「景点 / 街区 / 餐饮 / 住宿 / 自然 / 人文 / 交通」中选一个；day 用「第N天」，time 用「上午 / 下午 / 傍晚 / 晚上」之一。
- intro 用 50–90 字写清这个地点最值得看的 1–2 个点和怎么逛更顺，简洁到位、不要空话；highlights 给 2–3 条具体亮点（每条一句话）。
- tips、photo 各一句话的具体建议；cost 不确定时写「以现场公示为准」。
- 严格禁止编造经纬度、门牌号、评分、星级、网友评价、地铁线路号与精确票价；位置细节只能引用用户消息里的地图数据。
- 全部使用中文；不要输出解释文字或 Markdown 围栏。`

const guideMetaSchema = travelGuideSchema.omit({ days: true, spots: true })
const guideDaysSchema = z.object({ days: z.array(guideDaySchema).min(1).max(3) })

/** 单次输出越长越容易破损，指南按「概览 + 每 2 天一批 + 每 4 地一批图册」拆开生成 */
const DAYS_PER_BATCH = 2
const SPOTS_PER_BATCH = 4

function parseDays(value: string): number {
  const arabic = /(\d+)\s*[天日]/.exec(value)
  let days = arabic ? Number(arabic[1]) : 0
  if (!days) {
    const cn: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
    for (const [char, num] of Object.entries(cn)) {
      if (value.includes(`${char}天`)) {
        days = num
        break
      }
    }
  }
  return Math.min(Math.max(days || 3, 1), 8)
}

/** 模型漏写某个地点时给一张诚实降级的卡：不编造位置、评分、票价或开放信息 */
function fallbackSpot(name: string): GuideSpot {
  return {
    name,
    category: '景点',
    day: '第1天',
    time: '上午',
    stay: '以现场为准',
    intro: `${name} 的图文介绍本次未能完整生成。请通过卡片中的官方地图链接查看位置，并在出行前到官方渠道核实开放时间与预约要求；本指南不对该地点作未经核实的描述。`,
    highlights: [],
    tips: '开放时间、预约与票务信息请以官方渠道为准。',
    photo: '取景位置请以现场指引为准。',
    cost: '以现场公示为准',
  }
}

function forward(emit: GenerationEmit, stage: string): StructuredEmit {
  return (event) =>
    emit({
      type: event.kind === 'retry' ? 'retry' : 'log',
      stage,
      message: event.message,
      attempt: event.attempt,
      detail: event.detail,
    })
}

export async function generateOptions(
  config: LLMConfigRecord,
  requirement: string,
  model: string,
  emit: GenerationEmit,
  research = '',
): Promise<{ options: PlanOption[]; places: string[]; city: string }> {
  emit({ type: 'stage', stage: 'options', message: '正在连接模型服务，生成 3 个定制方案', current: 0, total: 1 })
  const { value, attempts } = await chatStructured(
    config,
    {
      model,
      messages: [
        { role: 'system', content: OPTIONS_SYSTEM },
        {
          role: 'user',
          content: `我的旅行需求：${requirement}${research ? `\n\n${research}\n\n参考以上用户实采线索规划方案：可采纳其中的地点与玩法，但不得编造评分，也不要虚构未列出的店名；线索仅作参考，具体营业与票价请提示我自行核实。` : ''}`,
        },
      ],
      temperature: 0.7,
      maxTokens: 2000,
    },
    planOptionsSchema,
    { emit: forward(emit, 'options') },
  )
  emit({ type: 'progress', stage: 'options', message: `候选方案已生成（第 ${attempts} 次成功）`, current: 1, total: 1 })
  // 取证与地图定位都只处理前 8 个地点；多出来的直接丢弃，不让数组长度变成生成失败点
  return { options: value.options, places: (value.places ?? []).slice(0, 8), city: (value.city ?? '').trim() }
}

export async function generateGuide(
  config: LLMConfigRecord,
  requirement: string,
  selected: PlanOption,
  model: string,
  emit: GenerationEmit,
  context: GuideContext = {},
): Promise<TravelGuide> {
  const totalDays = parseDays(selected.days)
  const batches: Array<{ from: number; to: number }> = []
  for (let from = 1; from <= totalDays; from += DAYS_PER_BATCH) {
    batches.push({ from, to: Math.min(from + DAYS_PER_BATCH - 1, totalDays) })
  }
  const places = [...new Set((context.places ?? []).map((item) => item.trim()).filter(Boolean))].slice(0, 8)
  const spotBatches: string[][] = []
  for (let from = 0; from < places.length; from += SPOTS_PER_BATCH) {
    spotBatches.push(places.slice(from, from + SPOTS_PER_BATCH))
  }
  const totalSteps = 1 + batches.length + spotBatches.length + 1 // 概览 + 行程 + 图册 + 校验

  emit({
    type: 'stage',
    stage: 'guide_meta',
    message: `共 ${totalDays} 天行程，先生成指南概览、预算与行前清单`,
    current: 1,
    total: totalSteps,
  })
  const meta = await chatStructured(
    config,
    {
      model,
      messages: [
        { role: 'system', content: GUIDE_META_SYSTEM },
        {
          role: 'user',
          content: `原始需求：${requirement}\n\n我选定的方案：${JSON.stringify(selected)}\n\n请生成指南概览部分。${context.research ? `\n\n${context.research}` : ''}${context.geo ? `\n\n${context.geo}` : ''}`,
        },
      ],
      temperature: 0.7,
      maxTokens: 2400,
    },
    guideMetaSchema,
    { emit: forward(emit, 'guide_meta') },
  )

  const days: GuideDay[] = []
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index]
    emit({
      type: 'stage',
      stage: 'guide_days',
      message: `正在生成第 ${batch.from}–${batch.to} 天详细行程（${index + 1}/${batches.length} 批）`,
      current: index + 2,
      total: totalSteps,
    })
    const part = await chatStructured(
      config,
      {
        model,
        messages: [
          { role: 'system', content: GUIDE_DAYS_SYSTEM },
          {
            role: 'user',
            content:
              `原始需求：${requirement}\n\n选定方案：${JSON.stringify(selected)}\n` +
              `指南标题：${meta.value.title}\n` +
              `本次只生成第 ${batch.from} 天到第 ${batch.to} 天，共 ${batch.to - batch.from + 1} 天。` +
              `可安排的地点：${places.join('、') || '按需求自行安排'}。` +
              (days.length ? `\n已生成的前序行程主题：${days.map((d) => `${d.day} ${d.title}`).join('；')}，请保持连贯且避免重复。` : '') +
              (context.research
                ? '\n\n【用户实采笔记参考】可采纳笔记里的具体店名、街区与玩法让行程更真实，但点赞数是热度不是评分，禁止写「评分高/口碑好」；不得虚构未列出的店名，票价与营业时间提示用户回源核实；文字按短句清单写，不要展开成长段落。'
                : '') +
              (context.geo ? `\n\n${context.geo}` : ''),
          },
        ],
        temperature: 0.7,
        maxTokens: 2800,
      },
      guideDaysSchema,
      { emit: forward(emit, 'guide_days') },
    )
    days.push(...part.value.days)
    emit({
      type: 'progress',
      stage: 'guide_days',
      message: `第 ${batch.from}–${batch.to} 天行程完成`,
      current: index + 2,
      total: totalSteps,
    })
  }

  // 地点图册放在行程之后：模型能看到已定的 day / time，图文卡与行程才对得上
  const spots: GuideSpot[] = []
  const itineraryBrief = days
    .map((day) => `${day.day} ${day.title}｜上午 ${day.morning.slice(0, 70)}｜下午 ${day.afternoon.slice(0, 70)}｜晚上 ${day.evening.slice(0, 70)}`)
    .join('\n')
  for (let index = 0; index < spotBatches.length; index += 1) {
    const batch = spotBatches[index]
    const current = 2 + batches.length + index
    emit({
      type: 'stage',
      stage: 'guide_spots',
      message: `正在撰写地点图册「${batch.join('、')}」（${index + 1}/${spotBatches.length} 批）`,
      current,
      total: totalSteps,
    })
    // 不硬卡数组长度：模型多写或漏写都按地点名对齐，避免整批重试失败
    const spotBatchSchema = z.object({ spots: z.array(guideSpotSchema).min(1).max(16) })
    const part = await chatStructured(
      config,
      {
        model,
        messages: [
          { role: 'system', content: GUIDE_SPOTS_SYSTEM },
          {
            role: 'user',
            content:
              `原始需求：${requirement}\n\n选定方案：${JSON.stringify(selected)}\n\n` +
              `已生成的行程（用于对齐 day 与 time）：\n${itineraryBrief}\n\n` +
              `本次只为以下 ${batch.length} 个地点撰写图文卡，每个恰好 1 条，顺序与名称保持一致：\n` +
              batch.map((name, i) => `${i + 1}. ${name}`).join('\n') +
              (context.geo ? `\n\n${context.geo}` : '') +
              (context.research ? '\n\n【用户实采笔记】可参考笔记里的地点描述与玩法，但不得写评分、星级或把点赞数当口碑；位置细节只引用地图数据；每张卡会另配相关笔记图片，你的文案不要重复图片内容。' : ''),
          },
        ],
        temperature: 0.6,
        maxTokens: 2800,
      },
      spotBatchSchema,
      { emit: forward(emit, 'guide_spots') },
    )
    const returned = part.value.spots
    for (const name of batch) {
      const hit =
        returned.find((item) => item.name.trim() === name) ??
        returned.find((item) => item.name.includes(name) || name.includes(item.name))
      // 强制用给定地点名，保证图文卡与地图定位证据能精确匹配
      spots.push(hit ? { ...hit, name } : fallbackSpot(name))
    }
    emit({
      type: 'progress',
      stage: 'guide_spots',
      message: `已生成 ${spots.length}/${places.length} 个地点的图文卡`,
      current,
      total: totalSteps,
    })
  }

  emit({ type: 'stage', stage: 'validate', message: '正在合并各批次并校验完整指南', current: totalSteps, total: totalSteps })
  // 合并后再跑一次全量 schema，任何一块字段缺失都会在这里给出可读错误
  return travelGuideSchema.parse({ ...meta.value, days, spots })
}
