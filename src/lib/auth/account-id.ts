export const ACCOUNT_ID_PATTERN = /^[가-힣a-z0-9_]{2,20}$/u;
export const ACCOUNT_ID_DOMAIN = "accounts.ddakbamonline.com";

export function normalizeAccountId(accountId: string): string {
  return accountId.trim().normalize("NFC").toLowerCase();
}

export function validateAccountId(accountId: string): boolean {
  return ACCOUNT_ID_PATTERN.test(normalizeAccountId(accountId));
}

export async function accountIdEmail(value: string): Promise<string> {
  const accountId = normalizeAccountId(value);

  if (!validateAccountId(accountId)) {
    throw new Error("아이디는 한글, 영문 소문자, 숫자, 밑줄 2~20자로 입력해 주세요.");
  }

  if (/^[a-z0-9_]+$/.test(accountId)) {
    return `${accountId}@${ACCOUNT_ID_DOMAIN}`;
  }

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(accountId),
  );
  const encoded = btoa(
    String.fromCharCode(...new Uint8Array(digest)),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")
    .toLowerCase();

  return `u-${encoded}@${ACCOUNT_ID_DOMAIN}`;
}
