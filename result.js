import { hashString, seededRandom } from "./selection.js";

// 結果に残すカード・短文・時間軸を組み立てます。

const STORY_TYPE_SCORES = {
  time: ["time", "change", "return", "distance", "transition", "childhood", "school", "work"],
  people: ["people", "family", "friend", "romance", "parenting", "librarian"],
  place: ["place", "comfort", "weather", "evening", "sensory", "routine"],
  book: ["book", "reading", "borrowing", "discovery", "study"],
  fragments: ["memory", "nostalgia", "accident", "embarrassment", "joy", "sadness", "solitude"],
};

const STORY_TEMPLATES = {
  time: [
    ["{time}の図書館。", "通い方も、そばにいる人も、少しずつ変わっていく。", "それぞれの時間が、静かに同じ場所へつながっています。"],
    ["連れて行ってもらった日も、自分で扉を開けた日も。", "図書館をめぐる時間は、ところどころ姿を変えて、", "いまの記憶へ続いています。"],
  ],
  people: [
    ["図書館で思い出すのは、本のことだけではありません。", "{people}の気配や、交わした言葉、ただ見ていた時間。", "人のいる風景も、そっと残っています。"],
    ["静かな棚のあいだに、{people}との時間がありました。", "話したことも、話さなかったことも、", "本と一緒に記憶の中へしまわれています。"],
  ],
  place: [
    ["{detail}。", "そこにあった光や音まで、少しずつ戻ってくる。", "図書館の風景は、記憶の中でまだ静かに続いています。"],
    ["棚のあいだ、いつもの席、窓の向こう。", "{detail}という小さな手がかりから、", "ひとつの図書館の風景が浮かびます。"],
  ],
  book: [
    ["一冊を選んだ理由は、{bookDetail}。", "その出会いから別の棚へ、別の時間へ。", "本をめぐる記憶が、いまも細くつながっています。"],
    ["覚えている表紙も、もう思い出せない題名も。", "本を探して手を伸ばした時間が、", "図書館の風景の中に残っています。"],
  ],
  fragments: [
    ["はっきりした場面と、雰囲気だけの場面。", "{detail}という小さな断片を拾うと、", "いくつかの図書館が、ゆっくり一枚の風景になります。"],
    ["すべてを覚えていなくても、残っているものがあります。", "音や光、棚の並び、そこで過ごした少しの時間。", "記憶の断片が、静かに隣り合っています。"],
  ],
};

const TIME_STAGES = [
  { key: "childhood", label: "CHILDHOOD", matches: [/幼いころ/, /小学生/] },
  { key: "school", label: "SCHOOL DAYS", matches: [/中高生/] },
  { key: "youth", label: "YOUTH", matches: [/大学/, /専門学校/] },
  { key: "working", label: "WORKING DAYS", matches: [/社会人/] },
  { key: "now", label: "NOW", matches: [/最近/] },
];

function getQuestion(data, id) {
  return data.questions.find((question) => question.id === id);
}

export function getAnswerLabels(data, memory, questionId) {
  const question = getQuestion(data, questionId);
  return (memory.answers?.[questionId] || [])
    .map((id) => question?.options.find((option) => option.id === id)?.label)
    .filter(Boolean);
}

function memorySimilarity(card, otherCards) {
  if (!otherCards.length) return 0;
  return otherCards.reduce((sum, other) => {
    const overlap = card.tags.filter((tag) => other.tags.includes(tag)).length;
    return sum + overlap / Math.max(1, new Set([...card.tags, ...other.tags]).size);
  }, 0) / otherCards.length;
}

export function selectRepresentativeMemories(data, state, count = 4) {
  const completed = state.selectedMemories.filter((memory) => memory.completed !== false);
  if (completed.length <= count) return completed;

  const scored = completed.map((memory, index) => {
    const card = data.cards.find((item) => item.id === memory.cardId);
    const otherCards = completed
      .filter((item) => item !== memory)
      .map((item) => data.cards.find((candidate) => candidate.id === item.cardId))
      .filter(Boolean);
    const centrality = card ? memorySimilarity(card, otherCards) : 0;
    const keep = getAnswerLabels(data, memory, "q038")[0];
    const self = getAnswerLabels(data, memory, "q039")[0];
    const keepBonus = keep === "ぜひ残したい" ? 3 : keep === "候補に残したい" ? 1.6 : 0;
    const selfBonus = self === "かなり自分らしい" ? 2.2 : self === "少し自分らしい" ? 1.2 : self === "むしろ意外な記憶" ? 1.5 : 0;
    const distinctive = 1 - centrality;
    const finaleWeight = card?.finaleWeight || 1;
    const noise = seededRandom(hashString(`${state.seed}:${memory.cardId}:result`))() * 0.32;
    return { memory, index, centrality, distinctive, score: centrality * 3 + keepBonus + selfBonus + finaleWeight + noise };
  });

  const result = [];
  const add = (item) => {
    if (item && !result.includes(item.memory)) result.push(item.memory);
  };
  add([...scored].sort((a, b) => b.score - a.score)[0]);
  add([...scored].sort((a, b) => {
    const aKeep = getAnswerLabels(data, a.memory, "q038")[0] === "ぜひ残したい" ? 1 : 0;
    const bKeep = getAnswerLabels(data, b.memory, "q038")[0] === "ぜひ残したい" ? 1 : 0;
    return bKeep - aKeep || b.score - a.score;
  })[0]);
  const timeRank = (item) => {
    const label = getAnswerLabels(data, item.memory, "q001")[0] || "";
    return TIME_STAGES.findIndex((stage) => stage.matches.some((pattern) => pattern.test(label)));
  };
  const temporal = scored.filter((item) => timeRank(item) >= 0).sort((a, b) => timeRank(a) - timeRank(b));
  if (temporal.length) {
    const edge = hashString(`${state.seed}:temporal`) % 2 === 0 ? temporal[0] : temporal[temporal.length - 1];
    add(edge);
  }
  add([...scored].sort((a, b) => b.distinctive - a.distinctive || b.score - a.score)[0]);

  for (const item of [...scored].sort((a, b) => b.score - a.score)) {
    if (result.length >= count) break;
    add(item);
  }
  return result.slice(0, count);
}

function allUsefulLabels(data, memories) {
  const ignored = /覚えていない|わからない|どちらでも|どちらとも|うまく言えない|特に何も|その後は特に/;
  return memories.flatMap((memory) => Object.entries(memory.answers || {}).flatMap(([questionId]) =>
    getAnswerLabels(data, memory, questionId).filter((label) => !ignored.test(label)),
  ));
}

export function selectStoryType(weights) {
  const totals = Object.entries(STORY_TYPE_SCORES).map(([type, tags]) => ({
    type,
    score: tags.reduce((sum, tag) => sum + (weights[tag] || 0), 0),
  }));
  totals.sort((a, b) => b.score - a.score);
  return totals[0]?.score > 0 ? totals[0].type : "fragments";
}

export function buildStory(data, state, memories) {
  const type = selectStoryType(state.tagWeights || {});
  const templateSet = STORY_TEMPLATES[type];
  const template = templateSet[hashString(`${state.seed}:${type}:${memories.length}`) % templateSet.length];
  const labels = allUsefulLabels(data, memories);
  const time = labels.find((label) => /幼いころ|小学生|中高生|大学|専門学校|社会人|最近/.test(label)) || "いくつかの頃";
  const people = labels.find((label) => /家族|友達|好きな人|気になる人|先生|学校の人|子ども/.test(label)) || "誰か";
  const detail = labels.find((label) => /窓|棚|机|椅子|静か|明るい|暗い|広い|小さい|古い|新しい|落ち着|雨|雪|外の景色/.test(label)) || "光や音、棚の並び";
  const bookDetail = labels.find((label) => /表紙|タイトル|作家|偶然|おすすめ|授業|課題/.test(label)) || "ふと目に留まったこと";

  return {
    type,
    lines: template.map((line) => line
      .replace("{time}", time)
      .replace("{people}", people)
      .replace("{detail}", detail)
      .replace("{bookDetail}", bookDetail)),
  };
}

export function buildTimeline(data, memories) {
  const timeLabels = memories.flatMap((memory) => getAnswerLabels(data, memory, "q001"));
  const activeKeys = TIME_STAGES
    .filter((stage) => timeLabels.some((label) => stage.matches.some((pattern) => pattern.test(label))))
    .map((stage) => stage.key);
  return activeKeys.length ? TIME_STAGES.map((stage) => ({ ...stage, active: activeKeys.includes(stage.key) })) : [];
}

export function getMemoryDetails(data, memory, limit = 2) {
  const priority = ["q001", "q002", "q019", "q021", "q006", "q023", "q026", "q027", "q010", "q036", "q004"];
  const ignored = /覚えていない|よく覚えていない|あまり覚えていない|どちら|うまく言えない|今回は残さなくていい/;
  const details = [];

  for (const questionId of priority) {
    const labels = getAnswerLabels(data, memory, questionId).filter((label) => !ignored.test(label));
    if (labels.length) details.push(labels.slice(0, 2).join("・"));
    if (details.length >= limit) break;
  }
  return details.slice(0, limit);
}
