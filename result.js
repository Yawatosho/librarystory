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
    ["{timeRange}。", "{timeExamples}という出来事を思い出しました。"],
  ],
  people: [
    ["{peopleExamples}。", "図書館の記憶には、人のことも残っていました。"],
  ],
  place: [
    ["{placeDetails}。", "{placeExamples}という記憶もありました。"],
  ],
  book: [
    ["{bookExamples}。", "本を選んだときや、棚を歩いたときのことも思い出しました。"],
  ],
  fragments: [
    ["{memoryExamples}。", "ばらばらの記憶ですが、どれも図書館で起きたことでした。"],
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
    const distinctive = 1 - centrality;
    const finaleWeight = card?.finaleWeight || 1;
    const detailCount = Object.entries(memory.answers || {}).reduce((sum, [questionId, optionIds]) => {
      const question = getQuestion(data, questionId);
      if (!question || question.enabled === false || ["q038", "q039"].includes(questionId)) return sum;
      return sum + Math.min((optionIds || []).length, 2);
    }, 0);
    const noise = seededRandom(hashString(`${state.seed}:${memory.cardId}:result`))() * 0.32;
    return {
      memory,
      index,
      centrality,
      distinctive,
      detailCount,
      score: centrality * 3 + Math.min(detailCount, 4) * 0.55 + finaleWeight + noise,
    };
  });

  const result = [];
  const add = (item) => {
    if (item && !result.includes(item.memory)) result.push(item.memory);
  };
  add([...scored].sort((a, b) => b.score - a.score)[0]);
  add([...scored].sort((a, b) => b.detailCount - a.detailCount || b.score - a.score)[0]);
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
  const timeLabels = [...new Set(labels.filter((label) => /幼いころ|小学生|中高生|大学|専門学校|社会人|最近/.test(label)))]
    .sort((a, b) => {
      const rank = (label) => TIME_STAGES.findIndex((stage) => stage.matches.some((pattern) => pattern.test(label)));
      return rank(a) - rank(b);
    });
  const timeRange = timeLabels.length > 1
    ? `${timeLabels[0]}の図書館と、${timeLabels[timeLabels.length - 1]}の図書館`
    : `${timeLabels[0] || "以前"}の図書館`;
  const placeLabels = [...new Set(labels.filter((label) => /窓|棚|机|椅子|静か|明るい|暗い|広い|小さい|古い|新しい|落ち着|雨|雪|外の景色|閉館/.test(label)))];
  const placeDetails = placeLabels.length ? placeLabels.slice(0, 3).join("、") : "いつもの席や、館内の様子";
  const exampleForTags = (tags, fallback) => {
    const matching = memories
      .map((memory) => data.cards.find((card) => card.id === memory.cardId))
      .filter((card) => card && (!tags.length || card.tags.some((tag) => tags.includes(tag))))
      .slice(0, 2)
      .map((card) => `「${card.title}」`)
      .join("と");
    return matching || fallback;
  };
  const memoryExamples = exampleForTags([], "いくつかの出来事");
  const timeExamples = exampleForTags(["change", "return", "distance", "transition", "childhood", "school", "work"], memoryExamples);
  const peopleExamples = exampleForTags(["people", "family", "friend", "romance", "parenting", "librarian"], memoryExamples);
  const placeExamples = exampleForTags(["place", "comfort", "weather", "evening", "sensory"], memoryExamples);
  const bookExamples = exampleForTags(["book", "reading", "borrowing", "discovery", "study"], memoryExamples);

  return {
    type,
    lines: template.map((line) => line
      .replace("{timeRange}", timeRange)
      .replace("{timeExamples}", timeExamples)
      .replace("{peopleExamples}", peopleExamples)
      .replace("{placeDetails}", placeDetails)
      .replace("{placeExamples}", placeExamples)
      .replace("{bookExamples}", bookExamples)
      .replace("{memoryExamples}", memoryExamples)),
  };
}

export function buildTimeline(data, memories) {
  const timeLabels = memories.flatMap((memory) => getAnswerLabels(data, memory, "q001"));
  const activeKeys = TIME_STAGES
    .filter((stage) => timeLabels.some((label) => stage.matches.some((pattern) => pattern.test(label))))
    .map((stage) => stage.key);
  return activeKeys.length >= 2 ? TIME_STAGES.map((stage) => ({ ...stage, active: activeKeys.includes(stage.key) })) : [];
}

export function getMemoryDetails(data, memory, limit = 2) {
  const priority = ["q001", "q002", "q019", "q021", "q006", "q023", "q026", "q027", "q010", "q036", "q004"];
  const ignored = /覚えていない|よく覚えていない|あまり覚えていない|どちら|うまく言えない|今回は残さなくていい/;
  const details = [];
  const questionIds = [
    ...priority,
    ...Object.keys(memory.answers || {}).filter((id) => !priority.includes(id) && !["q038", "q039"].includes(id)),
  ];

  for (const questionId of questionIds) {
    const labels = getAnswerLabels(data, memory, questionId).filter((label) => !ignored.test(label));
    if (labels.length) details.push(labels.slice(0, 2).join("・"));
    if (details.length >= limit) break;
  }
  return details.slice(0, limit);
}
