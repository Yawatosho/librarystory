import { hashString, seededRandom } from "./selection.js";

// 結果に残すカードと、回答から添える具体的な情報を選びます。

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

  const scored = completed.map((memory) => {
    const card = data.cards.find((item) => item.id === memory.cardId);
    const otherCards = completed
      .filter((item) => item !== memory)
      .map((item) => data.cards.find((candidate) => candidate.id === item.cardId))
      .filter(Boolean);
    const centrality = card ? memorySimilarity(card, otherCards) : 0;
    const distinctive = 1 - centrality;
    const detailCount = Object.entries(memory.answers || {}).reduce((sum, [questionId, optionIds]) => {
      const question = getQuestion(data, questionId);
      if (!question || question.enabled === false || ["q038", "q039"].includes(questionId)) return sum;
      return sum + Math.min((optionIds || []).length, 2);
    }, 0);
    const noise = seededRandom(hashString(`${state.seed}:${memory.cardId}:result`))() * 0.32;
    return {
      memory,
      centrality,
      distinctive,
      detailCount,
      score: centrality * 3 + Math.min(detailCount, 4) * 0.55 + noise,
    };
  });

  const result = [];
  const add = (item) => {
    if (item && !result.includes(item.memory)) result.push(item.memory);
  };
  add([...scored].sort((a, b) => b.score - a.score)[0]);
  add([...scored].sort((a, b) => b.detailCount - a.detailCount || b.score - a.score)[0]);
  add([...scored].sort((a, b) => b.distinctive - a.distinctive || b.score - a.score)[0]);

  for (const item of [...scored].sort((a, b) => b.score - a.score)) {
    if (result.length >= count) break;
    add(item);
  }
  return result.slice(0, count);
}

export function getMemoryDetails(data, memory, limit = 2) {
  const priority = ["q001", "q002", "q019", "q021", "q006", "q023", "q026", "q027", "q010", "q036", "q004"];
  const ignored = /覚えていない|よく覚えていない|あまり覚えていない|わからない|思い浮かばない|たぶんない|特にない|どちら|うまく言えない|今回は残さなくていい/;
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
