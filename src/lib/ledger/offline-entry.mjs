export function normalizeDisplayName(value) {
  const normalized = String(value).trim();
  if (normalized.length < 2 || normalized.length > 24) {
    throw new Error("이름은 2~24자로 입력해 주세요.");
  }
  return normalized;
}

export function normalizeOfflineHits(value) {
  const normalized = String(value);
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error("딱밤 횟수는 1 이상의 정수로 입력해 주세요.");
  }
  return normalized;
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
