export const ACCOUNT_ID_PATTERN = /^[a-z0-9_]{4,20}$/;
export const ACCOUNT_ID_DOMAIN = "accounts.ddakbam.invalid";

export function normalizeAccountId(accountId: string): string {
  return accountId.trim().toLowerCase();
}

export function validateAccountId(accountId: string): boolean {
  return ACCOUNT_ID_PATTERN.test(normalizeAccountId(accountId));
}

export function accountIdEmail(value: string): string {
  const accountId = normalizeAccountId(value);

  if (!validateAccountId(accountId)) {
    throw new Error("아이디는 영문 소문자, 숫자, 밑줄 4~20자로 입력해 주세요.");
  }

  return `${accountId}@${ACCOUNT_ID_DOMAIN}`;
}
