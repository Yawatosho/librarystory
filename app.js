import {
  chooseQuestions,
  hashString,
  recalculateTagWeights,
  selectInitialCards,
  selectNextCards,
} from "./selection.js";
import {
  getMemoryDetails,
  selectRepresentativeMemories,
} from "./result.js";

// 後から調整する値はここに集約しています。
export const CONFIG = Object.freeze({
  displayCardCount: 8,
  playRounds: 4,
  questionMin: 2,
  questionMax: 3,
  resultCardCount: 4,
  recommendation: {
    near: 0.5,
    explore: 0.375,
    surprise: 0.125,
  },
});

const STORAGE_KEY = "your-library-story:v01";
const DATA_URL = "data/your-library-story-memory-data-v01.json";
const ACCENT_COLORS = ["#315e57", "#896d43", "#6c7660", "#7b5e59", "#526779"];

const elements = {
  screens: [...document.querySelectorAll(".screen")],
  title: document.querySelector("#title-screen"),
  selection: document.querySelector("#selection-screen"),
  question: document.querySelector("#question-screen"),
  result: document.querySelector("#result-screen"),
  error: document.querySelector("#error-screen"),
  startButton: document.querySelector("#start-button"),
  resumeNote: document.querySelector("#resume-note"),
  selectionHint: document.querySelector("#selection-hint"),
  cardGrid: document.querySelector("#card-grid"),
  questionBack: document.querySelector("#question-back"),
  questionProgress: document.querySelector("#question-progress"),
  currentMemoryTitle: document.querySelector("#current-memory-title"),
  questionStage: document.querySelector("#question-stage"),
  questionText: document.querySelector("#question-text"),
  multiHint: document.querySelector("#multi-hint"),
  answerOptions: document.querySelector("#answer-options"),
  answerNext: document.querySelector("#answer-next"),
  resultAlbum: document.querySelector("#result-album"),
  exploreButton: document.querySelector("#explore-button"),
  resetButton: document.querySelector("#reset-button"),
};

let data = null;
let state = createFreshState();
let advanceTimer = null;
let cardPickTimer = null;

function createFreshState() {
  return {
    version: 1,
    screen: "selection",
    seed: Date.now() >>> 0,
    selectedMemories: [],
    shownCardIds: [],
    currentBatch: [],
    activeMemoryIndex: null,
    currentQuestionIndex: 0,
    tagWeights: {},
    exploreMode: false,
  };
}

function isValidState(candidate) {
  return candidate
    && candidate.version === 1
    && Array.isArray(candidate.selectedMemories)
    && Array.isArray(candidate.shownCardIds)
    && Array.isArray(candidate.currentBatch);
}

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return isValidState(parsed) ? { ...createFreshState(), ...parsed } : createFreshState();
  } catch {
    return createFreshState();
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 保存できない環境でも、その場のプレイは続けます。
  }
}

function showScreen(name) {
  const target = elements[name];
  elements.screens.forEach((screen) => {
    const active = screen === target;
    screen.hidden = !active;
    screen.classList.toggle("is-active", active);
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function completedCount() {
  return state.selectedMemories.filter((memory) => memory.completed).length;
}

function getActiveMemory() {
  return state.activeMemoryIndex == null ? null : state.selectedMemories[state.activeMemoryIndex];
}

function prepareBatch(initial = false) {
  const initialRules = data.selectionRules?.initial || {};
  const nextRules = data.selectionRules?.next || {};
  const displayCount = initial
    ? initialRules.count || CONFIG.displayCardCount
    : nextRules.count || CONFIG.displayCardCount;
  const selectionConfig = {
    ...CONFIG,
    displayCardCount: displayCount,
    recommendation: {
      near: nextRules.nearRatio ?? CONFIG.recommendation.near,
      explore: nextRules.exploreRatio ?? CONFIG.recommendation.explore,
      surprise: nextRules.surpriseRatio ?? CONFIG.recommendation.surprise,
    },
  };
  const cards = initial
    ? selectInitialCards(data.cards, displayCount, state.seed)
    : selectNextCards(data, state, selectionConfig);
  state.currentBatch = cards.map((card) => card.id);
  state.shownCardIds = [...new Set([...state.shownCardIds, ...state.currentBatch])];
  saveState();
}

function renderSelection() {
  state.screen = "selection";
  elements.selectionHint.textContent = state.exploreMode
    ? "まだ選んでいない記憶を並べました。"
    : "気になる記憶を選んでみてください。";
  elements.cardGrid.replaceChildren();

  const cards = state.currentBatch
    .map((id) => data.cards.find((card) => card.id === id))
    .filter(Boolean);
  cards.forEach((card, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "memory-card";
    button.style.setProperty("--card-index", index);
    button.style.setProperty("--card-accent", ACCENT_COLORS[index % ACCENT_COLORS.length]);
    applyMemoryCardLayout(button, card);
    button.setAttribute("aria-label", `${card.title}。${card.subtitle}`);
    button.innerHTML = `
      <span class="memory-card-inner">
        <span class="memory-card-copy">
          <h3>${escapeHtml(card.title)}</h3>
          <p>${escapeHtml(card.subtitle)}</p>
        </span>
      </span>`;
    button.addEventListener("click", () => pickMemory(card, button));
    elements.cardGrid.append(button);
  });
  saveState();
  showScreen("selection");
}

function pickMemory(card, button) {
  if (cardPickTimer) return;
  button.classList.add("is-picked");
  button.disabled = true;
  cardPickTimer = setTimeout(() => {
    cardPickTimer = null;
    beginMemory(card);
  }, 220);
}

function beginMemory(card) {
  if (advanceTimer) clearTimeout(advanceTimer);
  const questions = chooseQuestions(card, data.questions, CONFIG, state.selectedMemories.length, state.seed);
  const memory = {
    cardId: card.id,
    questionIds: questions.map((question) => question.id),
    answers: {},
    completed: questions.length === 0,
    selectedAt: Date.now(),
  };
  state.selectedMemories.push(memory);
  state.activeMemoryIndex = state.selectedMemories.length - 1;
  state.currentQuestionIndex = 0;
  state.currentBatch = state.currentBatch.filter((id) => id !== card.id);
  saveState();

  // 質問のないカードでも体験を止めず、次の記憶へ進めます。
  if (!questions.length) {
    completeMemory();
    return;
  }
  renderQuestion();
}

function renderQuestion() {
  const memory = getActiveMemory();
  const card = data.cards.find((item) => item.id === memory?.cardId);
  const questionId = memory?.questionIds[state.currentQuestionIndex];
  const question = data.questions.find((item) => item.id === questionId);
  if (!memory || !card || !question) {
    completeMemory();
    return;
  }

  state.screen = "question";
  elements.currentMemoryTitle.textContent = card.title;
  elements.questionProgress.textContent = `${state.currentQuestionIndex + 1} / ${memory.questionIds.length}`;
  elements.questionText.textContent = question.text;
  elements.multiHint.hidden = question.type !== "multi";
  elements.answerOptions.replaceChildren();
  const saved = new Set(memory.answers[question.id] || []);

  question.options.forEach((option) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `answer-option${saved.has(option.id) ? " is-selected" : ""}`;
    button.textContent = option.label;
    button.setAttribute("aria-pressed", saved.has(option.id) ? "true" : "false");
    button.addEventListener("click", () => answerQuestion(question, option.id));
    elements.answerOptions.append(button);
  });

  elements.answerNext.hidden = question.type !== "multi" || saved.size === 0;
  saveState();
  showScreen("question");
  animateQuestionStage();
}

function answerQuestion(question, optionId) {
  const memory = getActiveMemory();
  if (!memory) return;

  if (question.type === "multi") {
    const selected = new Set(memory.answers[question.id] || []);
    selected.has(optionId) ? selected.delete(optionId) : selected.add(optionId);
    memory.answers[question.id] = [...selected];
    saveState();
    [...elements.answerOptions.children].forEach((button, index) => {
      const active = selected.has(question.options[index].id);
      button.classList.toggle("is-selected", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
    elements.answerNext.hidden = selected.size === 0;
    return;
  }

  // questionIdをキーに上書きし、戻ったときも回答を重複させません。
  memory.answers[question.id] = [optionId];
  saveState();
  [...elements.answerOptions.children].forEach((button, index) => {
    const selected = question.options[index].id === optionId;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", selected ? "true" : "false");
  });
  advanceTimer = setTimeout(advanceQuestion, 330);
}

function advanceQuestion() {
  advanceTimer = null;
  const memory = getActiveMemory();
  if (!memory) return;
  if (state.currentQuestionIndex < memory.questionIds.length - 1) {
    state.currentQuestionIndex += 1;
    renderQuestion();
  } else {
    completeMemory();
  }
}

function goBackQuestion() {
  if (advanceTimer) clearTimeout(advanceTimer);
  advanceTimer = null;
  if (state.currentQuestionIndex > 0) {
    state.currentQuestionIndex -= 1;
    renderQuestion();
    return;
  }

  // 最初の質問から戻る場合、選びかけの記憶だけを取り除きます。
  if (state.activeMemoryIndex != null) {
    const [cancelledMemory] = state.selectedMemories.splice(state.activeMemoryIndex, 1);
    if (cancelledMemory && !state.currentBatch.includes(cancelledMemory.cardId)) {
      state.currentBatch.unshift(cancelledMemory.cardId);
    }
  }
  state.activeMemoryIndex = null;
  state.currentQuestionIndex = 0;
  state.tagWeights = recalculateTagWeights(data, state);
  saveState();
  renderSelection();
}

function completeMemory() {
  const memory = getActiveMemory();
  if (memory) memory.completed = true;
  state.tagWeights = recalculateTagWeights(data, state);
  state.activeMemoryIndex = null;
  state.currentQuestionIndex = 0;

  if (state.exploreMode || completedCount() >= CONFIG.playRounds) {
    state.exploreMode = false;
    renderResult();
  } else {
    prepareBatch(false);
    renderSelection();
  }
}

function renderResult() {
  state.screen = "result";
  const memories = selectRepresentativeMemories(data, state, CONFIG.resultCardCount);
  elements.resultAlbum.replaceChildren();

  memories.forEach((memory, index) => {
    const card = data.cards.find((item) => item.id === memory.cardId);
    if (!card) return;
    const article = document.createElement("article");
    article.className = "album-card";
    article.style.setProperty("--album-index", index);
    applyAlbumCardLayout(article, card.id);
    const details = getMemoryDetails(data, memory);
    article.innerHTML = `
      <h3>${escapeHtml(card.title)}</h3>
      ${details.map((detail) => `<p class="album-detail">${escapeHtml(detail)}</p>`).join("")}`;
    elements.resultAlbum.append(article);
  });

  saveState();
  showScreen("result");
}

function exploreMore() {
  state.exploreMode = true;
  prepareBatch(false);
  renderSelection();
}

function resetExperience() {
  if (cardPickTimer) clearTimeout(cardPickTimer);
  cardPickTimer = null;
  localStorage.removeItem(STORAGE_KEY);
  state = createFreshState();
  prepareBatch(true);
  elements.resumeNote.hidden = true;
  const label = elements.startButton.querySelector("span");
  if (label) label.textContent = "はじめる";
  showScreen("title");
}

function animateQuestionStage() {
  elements.questionStage.classList.remove("is-changing");
  requestAnimationFrame(() => elements.questionStage.classList.add("is-changing"));
}

function applyMemoryCardLayout(element, card) {
  const seed = hashString(`layout:${card.id}`);
  const tilt = ((seed % 41) - 20) / 10;
  const x = ((seed >>> 5) % 17) - 8;
  const y = ((seed >>> 9) % 29) - 13;
  const mobileHeight = Math.max(185, Math.min(275, 118 + Math.ceil(card.title.length / 10) * 27
    + Math.ceil(card.subtitle.length / 13) * 22 + ((seed >>> 21) % 9)));
  const desktopHeight = Math.max(190, Math.min(260, 112 + Math.ceil(card.title.length / 13) * 27
    + Math.ceil(card.subtitle.length / 18) * 22 + ((seed >>> 21) % 9)));
  const spacing = 12 + ((seed >>> 13) % 19);
  const mobileSpan = Math.ceil((mobileHeight + spacing) / 8);
  const desktopSpan = Math.ceil((desktopHeight + spacing + 2) / 8);
  const paddingX = 13 + ((seed >>> 24) % 5);
  const paddingTop = 16 + ((seed >>> 27) % 7);
  element.style.setProperty("--card-tilt", `${tilt}deg`);
  element.style.setProperty("--card-hover-tilt", `${(tilt * 0.18).toFixed(2)}deg`);
  element.style.setProperty("--card-x", `${x}px`);
  element.style.setProperty("--card-y", `${y}px`);
  element.style.setProperty("--card-mobile-height", `${mobileHeight}px`);
  element.style.setProperty("--card-desktop-height", `${desktopHeight}px`);
  element.style.setProperty("--card-mobile-span", String(mobileSpan));
  element.style.setProperty("--card-desktop-span", String(desktopSpan));
  element.style.setProperty("--card-narrow", `${(seed >>> 17) % 15}px`);
  element.style.setProperty("--card-padding-x", `${paddingX}px`);
  element.style.setProperty("--card-padding-top", `${paddingTop}px`);
  element.style.setProperty("--card-z", String(1 + ((seed >>> 29) % 3)));
}

function applyAlbumCardLayout(element, cardId) {
  const seed = hashString(`album:${cardId}`);
  element.style.setProperty("--album-tilt", `${((seed % 45) - 22) / 10}deg`);
  element.style.setProperty("--album-x", `${((seed >>> 6) % 15) - 7}px`);
  element.style.setProperty("--album-y", `${((seed >>> 11) % 17) - 8}px`);
  element.style.setProperty("--album-z", String(1 + ((seed >>> 16) % 4)));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function resumeExperience() {
  if (!state.currentBatch.length && state.screen === "selection") {
    prepareBatch(completedCount() === 0);
  }
  if (state.screen === "question" && getActiveMemory()) renderQuestion();
  else if (state.screen === "result" && completedCount()) renderResult();
  else renderSelection();
}

async function initialize() {
  try {
    const response = await fetch(DATA_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    data = await response.json();
    if (!Array.isArray(data.cards) || !Array.isArray(data.questions)) throw new Error("Invalid data");

    state = loadState();
    state.selectedMemories = state.selectedMemories.filter((memory) => data.cards.some((card) => card.id === memory.cardId));
    const enabledQuestionIds = new Set(data.questions.filter((question) => question.enabled !== false).map((question) => question.id));
    state.selectedMemories.forEach((memory) => {
      memory.questionIds = (memory.questionIds || []).filter((id) => enabledQuestionIds.has(id));
      Object.keys(memory.answers || {}).forEach((id) => {
        if (!enabledQuestionIds.has(id)) delete memory.answers[id];
      });
    });
    const activeMemory = getActiveMemory();
    if (activeMemory) state.currentQuestionIndex = Math.min(state.currentQuestionIndex, Math.max(0, activeMemory.questionIds.length - 1));
    state.tagWeights = recalculateTagWeights(data, state);
    const hasProgress = state.selectedMemories.length > 0;
    elements.resumeNote.hidden = !hasProgress;
    if (hasProgress) elements.startButton.querySelector("span").textContent = "つづきから";

    elements.startButton.addEventListener("click", resumeExperience);
    elements.questionBack.addEventListener("click", goBackQuestion);
    elements.answerNext.addEventListener("click", advanceQuestion);
    elements.exploreButton.addEventListener("click", exploreMore);
    elements.resetButton.addEventListener("click", resetExperience);

    if (!hasProgress) prepareBatch(true);
    showScreen("title");
  } catch (error) {
    console.error("Memory data could not be loaded:", error);
    showScreen("error");
  }
}

initialize();
