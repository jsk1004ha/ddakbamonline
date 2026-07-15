export function normalizeDisplayName(value) {
  if (typeof value !== "string") {
    throw new Error("이름은 2~24자로 입력해 주세요.");
  }
  const normalized = value.trim();
  if (normalized.length < 2 || normalized.length > 24) {
    throw new Error("이름은 2~24자로 입력해 주세요.");
  }
  return normalized;
}

export function normalizeOfflineHits(value) {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw new Error("딱밤 횟수는 1 이상의 정수로 입력해 주세요.");
  }
  return value;
}

export function escapeIlikePattern(value) {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function buildProfileSearchPattern(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (normalized.length < 2 || normalized.length > 24) return null;
  return `%${escapeIlikePattern(normalized)}%`;
}

export function filterObligationsByName(obligations, names, query) {
  const normalizedQuery = query.trim().toLocaleLowerCase("ko-KR");
  if (!normalizedQuery) return obligations;

  return obligations.filter((obligation) => {
    const creditorName = names[obligation.creditor_id] ?? "";
    const debtorName = names[obligation.debtor_id] ?? "";
    return [creditorName, debtorName].some((name) =>
      name.toLocaleLowerCase("ko-KR").includes(normalizedQuery),
    );
  });
}

export function mergeObligationById(obligations, incoming) {
  return [incoming, ...obligations.filter((item) => item.id !== incoming.id)];
}

export function ledgerErrorMessage(error) {
  const message =
    error instanceof Error
      ? error.message
      : error &&
          typeof error === "object" &&
          "message" in error &&
          typeof error.message === "string"
        ? error.message
        : "";

  if (/^(?:딱밤|본인은 선택|로그인이|선택한 계정을)/.test(message)) {
    return message;
  }
  if (/authentication required|jwt|session/i.test(message)) {
    return "로그인이 만료됐어요. 다시 로그인한 뒤 시도해 주세요.";
  }
  if (/counterparty cannot be the same account/i.test(message)) {
    return "본인은 선택할 수 없어요.";
  }
  if (/counterparty account not found/i.test(message)) {
    return "선택한 계정을 찾지 못했어요. 이름으로 다시 찾아 주세요.";
  }
  if (/hits must be a positive canonical integer/i.test(message)) {
    return "딱밤 횟수는 1 이상의 정수로 입력해 주세요.";
  }
  if (/invalid offline obligation direction/i.test(message)) {
    return "딱밤 방향을 다시 선택해 주세요.";
  }
  if (/stale remaining hit count/i.test(message)) {
    return "다른 기기에서 먼저 반영했어요. 최신 상태로 다시 맞췄습니다.";
  }
  return "딱밤 장부 요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.";
}

export function mapOfflineParties(userId, counterpartyId, direction) {
  if (userId === counterpartyId) {
    throw new Error("본인은 선택할 수 없어요.");
  }
  if (direction === "i_hit") {
    return { creditorId: userId, debtorId: counterpartyId };
  }
  if (direction === "i_owe") {
    return { creditorId: counterpartyId, debtorId: userId };
  }
  throw new Error("딱밤 방향을 다시 선택해 주세요.");
}

export function createOfflineEntryUiState(searchRequestToken = 0) {
  return {
    direction: "i_hit",
    query: "",
    matches: [],
    selectedProfile: null,
    hits: "",
    hasSearched: false,
    localError: "",
    localNotice: "",
    searchRequestToken,
  };
}

export function reduceOfflineEntryUiState(state, action) {
  switch (action.type) {
    case "direction_changed":
      return { ...state, direction: action.direction };
    case "query_changed":
      return {
        ...state,
        query: action.query,
        matches: [],
        selectedProfile: null,
        hasSearched: false,
        localError: "",
        localNotice: "",
        searchRequestToken: action.requestToken,
      };
    case "hits_changed":
      return {
        ...state,
        hits: action.hits,
        localError: "",
        localNotice: "",
      };
    case "search_started":
      return {
        ...state,
        matches: [],
        selectedProfile: null,
        hasSearched: false,
        localError: "",
        localNotice: "",
        searchRequestToken: action.requestToken,
      };
    case "search_succeeded":
      if (action.requestToken !== state.searchRequestToken) return state;
      return { ...state, matches: action.matches, hasSearched: true };
    case "search_failed":
      if (action.requestToken !== state.searchRequestToken) return state;
      return {
        ...state,
        matches: [],
        selectedProfile: null,
        hasSearched: true,
        localError: action.error,
        localNotice: "",
      };
    case "profile_selected":
      return {
        ...state,
        selectedProfile: action.profile,
        localError: "",
        localNotice: "",
      };
    case "feedback_cleared":
      return { ...state, localError: "", localNotice: "" };
    case "validation_failed":
    case "submit_failed":
      return { ...state, localError: action.error, localNotice: "" };
    case "submit_succeeded":
      return {
        ...createOfflineEntryUiState(action.requestToken),
        localNotice: action.notice,
      };
    case "reset":
      return createOfflineEntryUiState(action.requestToken);
    default:
      return state;
  }
}
