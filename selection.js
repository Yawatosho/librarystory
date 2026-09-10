// カード提示と意味ネットワークの計算を担当します。

const ANSWER_TAG_RULES = [
  { pattern: /幼い|小学生/, tags: ["childhood", "nostalgia"] },
  { pattern: /中高生|大学|専門学校|学校/, tags: ["school"] },
  { pattern: /社会人|仕事/, tags: ["work"] },
  { pattern: /最近|今も/, tags: ["return"] },
  { pattern: /家族/, tags: ["family", "people"] },
  { pattern: /友達/, tags: ["friend", "people"] },
  { pattern: /好きな人|気になる人/, tags: ["romance", "people"] },
  { pattern: /子ども/, tags: ["parenting", "people"] },
  { pattern: /ひとり/, tags: ["solitude"] },
  { pattern: /窓|棚|机|椅子|カウンター|階段|廊下|照明|外の景色/, tags: ["place"] },
  { pattern: /静か|落ち着|休む/, tags: ["comfort"] },
  { pattern: /懐かし/, tags: ["nostalgia"] },
  { pattern: /雨|雪|晴れ|暑|寒|涼し/, tags: ["weather", "sensory"] },
  { pattern: /暗かった|閉館/, tags: ["evening"] },
  { pattern: /本|表紙|タイトル|作家|棚で偶然|おすすめ/, tags: ["book", "discovery"] },
  { pattern: /変わった|進学|卒業|引っ越し/, tags: ["change"] },
  { pattern: /ぜひ残したい|候補に残したい/, tags: ["nostalgia"] },
];

export function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < String(value).length; index += 1) {
    hash ^= String(value).charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(items, random) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function tagSimilarity(card, selectedCards) {
  if (!selectedCards.length) return 0;
  return selectedCards.reduce((total, selected) => {
    const shared = card.tags.filter((tag) => selected.tags.includes(tag)).length;
    const related = selected.relatedCardIds?.includes(card.id) || card.relatedCardIds?.includes(selected.id) ? 2.4 : 0;
    return total + shared + related;
  }, 0) / selectedCards.length;
}

function takeUnique(target, source, count) {
  for (const card of source) {
    if (target.length >= count) break;
    if (!target.some((item) => item.id === card.id)) target.push(card);
  }
}

export function selectInitialCards(cards, count, seed) {
  const random = seededRandom(hashString(`${seed}:initial`));
  const candidates = shuffled(cards.filter((card) => card.enabled !== false), random);
  const chosen = [];
  const tagCounts = {};

  // 入口では、JSONの推奨にある代表的な意味をまず横断します。
  const anchorTags = ["romance", "book", "people", "study", "place", "nostalgia", "comfort", "discovery"];
  anchorTags.forEach((anchor) => {
    if (chosen.length >= count || chosen.some((card) => card.tags.includes(anchor))) return;
    const matches = candidates
      .filter((card) => card.tags.includes(anchor))
      .map((card) => ({
        card,
        score: card.tags.filter((tag) => !tagCounts[tag]).length * 1.4
          - card.tags.reduce((sum, tag) => sum + (tagCounts[tag] || 0), 0) * 1.15
          + random(),
      }))
      .sort((a, b) => b.score - a.score);
    const next = matches[0]?.card;
    if (!next) return;
    chosen.push(next);
    next.tags.forEach((tag) => { tagCounts[tag] = (tagCounts[tag] || 0) + 1; });
    candidates.splice(candidates.findIndex((card) => card.id === next.id), 1);
  });

  while (chosen.length < count && candidates.length) {
    const ranked = candidates
      .map((card) => {
        const freshTags = card.tags.filter((tag) => !tagCounts[tag]).length;
        const balance = card.tags.reduce((sum, tag) => sum + 1 / (1 + (tagCounts[tag] || 0)), 0);
        const repetition = card.tags.reduce((sum, tag) => sum + (tagCounts[tag] || 0), 0);
        return { card, score: freshTags * 1.3 + balance - repetition * 1.05 + random() * 0.8 };
      })
      .sort((a, b) => b.score - a.score);
    const next = ranked[0].card;
    chosen.push(next);
    next.tags.forEach((tag) => { tagCounts[tag] = (tagCounts[tag] || 0) + 1; });
    candidates.splice(candidates.findIndex((card) => card.id === next.id), 1);
  }

  return chosen;
}

export function selectNextCards(data, state, config) {
  const seen = new Set(state.shownCardIds);
  const enabled = data.cards.filter((card) => card.enabled !== false);
  let candidates = enabled.filter((card) => !seen.has(card.id));

  // 全カードを見終えたときだけ、未選択カードから再び提示します。
  if (candidates.length < config.displayCardCount) {
    const selectedIds = new Set(state.selectedMemories.map((memory) => memory.cardId));
    candidates = enabled.filter((card) => !selectedIds.has(card.id));
  }

  const selectedCards = state.selectedMemories
    .map((memory) => data.cards.find((card) => card.id === memory.cardId))
    .filter(Boolean);
  const random = seededRandom(hashString(`${state.seed}:${state.selectedMemories.length}:${state.shownCardIds.length}`));
  const ranked = candidates.map((card) => ({
    card,
    similarity: tagSimilarity(card, selectedCards),
    novelty: card.tags.reduce((sum, tag) => sum + 1 / (1 + (state.tagWeights[tag] || 0)), 0),
    jitter: random(),
  }));

  const nearCount = Math.round(config.displayCardCount * config.recommendation.near);
  const exploreCount = Math.round(config.displayCardCount * config.recommendation.explore);
  const result = [];

  const near = [...ranked]
    .sort((a, b) => (b.similarity + b.jitter * 0.45) - (a.similarity + a.jitter * 0.45))
    .map((item) => item.card);
  takeUnique(result, near, nearCount);

  const explore = ranked
    .filter((item) => !result.some((card) => card.id === item.card.id))
    .sort((a, b) => (b.novelty + b.jitter * 0.75) - (a.novelty + a.jitter * 0.75))
    .map((item) => item.card);
  takeUnique(result, explore, nearCount + exploreCount);

  const surprise = ranked
    .filter((item) => !result.some((card) => card.id === item.card.id))
    .sort((a, b) => (a.similarity - a.jitter * 0.9) - (b.similarity - b.jitter * 0.9))
    .map((item) => item.card);
  takeUnique(result, surprise, config.displayCardCount);

  takeUnique(result, shuffled(candidates, random), config.displayCardCount);
  return shuffled(result, random);
}

export function chooseQuestions(card, allQuestions, config, memoryIndex, seed) {
  const available = (card.questionIds || [])
    .map((id) => allQuestions.find((question) => question.id === id))
    .filter((question) => question && question.enabled !== false);
  if (!available.length) return [];

  const desired = Math.min(
    available.length,
    config.questionMin + (hashString(`${seed}:${card.id}`) % (config.questionMax - config.questionMin + 1)),
  );
  const random = seededRandom(hashString(`${seed}:${card.id}:questions`));
  const selected = [];
  const reflectionId = memoryIndex % 2 === 0 ? "q038" : "q039";
  const reflection = available.find((question) => question.id === reflectionId)
    || available.find((question) => ["q038", "q039"].includes(question.id));

  const timeQuestion = available.find((question) => question.id === "q001");
  if (timeQuestion) selected.push(timeQuestion);

  const contextual = shuffled(
    available.filter((question) => !["q001", "q038", "q039", "q040"].includes(question.id)),
    random,
  ).sort((a, b) => {
    const aOverlap = a.tags.filter((tag) => card.tags.includes(tag)).length;
    const bOverlap = b.tags.filter((tag) => card.tags.includes(tag)).length;
    return bOverlap - aOverlap;
  });
  const reservedReflection = reflection && desired >= 3 ? 1 : 0;
  const contextualTarget = Math.max(1, desired - selected.length - reservedReflection);
  takeUnique(selected, contextual, selected.length + contextualTarget);

  if (reflection && desired >= 3 && !selected.some((question) => question.id === reflection.id)) {
    selected.push(reflection);
  }

  takeUnique(selected, shuffled(available, random), desired);
  return selected.slice(0, desired);
}

export function recalculateTagWeights(data, state) {
  const weights = {};
  const add = (tag, amount) => { weights[tag] = Number(((weights[tag] || 0) + amount).toFixed(2)); };

  state.selectedMemories.forEach((memory) => {
    const card = data.cards.find((item) => item.id === memory.cardId);
    card?.tags.forEach((tag) => add(tag, 1));

    Object.entries(memory.answers || {}).forEach(([questionId, optionIds]) => {
      const question = data.questions.find((item) => item.id === questionId);
      question?.tags.forEach((tag) => add(tag, 0.3));
      (optionIds || []).forEach((optionId) => {
        const label = question?.options.find((option) => option.id === optionId)?.label || "";
        ANSWER_TAG_RULES.forEach((rule) => {
          if (rule.pattern.test(label)) rule.tags.forEach((tag) => add(tag, 0.45));
        });
      });
    });
  });

  return weights;
}
