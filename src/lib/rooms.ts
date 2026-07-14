const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function normalizeRoomCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 6);
}

export function generateRoomCode(random: () => number = Math.random): string {
  return Array.from({ length: 6 }, () => {
    const index = Math.min(
      ROOM_CODE_ALPHABET.length - 1,
      Math.floor(Math.max(0, random()) * ROOM_CODE_ALPHABET.length),
    );
    return ROOM_CODE_ALPHABET[index];
  }).join("");
}

export function findFirstFreeSeat(
  members: ReadonlyArray<{ seat: number }>,
  maxPlayers: number,
): number | null {
  const occupied = new Set(members.map(({ seat }) => seat));
  for (let seat = 0; seat < Math.min(4, Math.max(0, maxPlayers)); seat += 1) {
    if (!occupied.has(seat)) return seat;
  }
  return null;
}

export function canStartRoom(
  members: ReadonlyArray<{ ready: boolean }>,
  maxPlayers: number,
): boolean {
  return (
    members.length >= 2 &&
    members.length <= Math.min(4, maxPlayers) &&
    members.every(({ ready }) => ready)
  );
}
