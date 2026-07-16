"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  createDeck,
  evaluateHand,
  type Card,
} from "@/lib/game/engine.mjs";
import {
  COMPACT_HAND_RANKING,
  handRankingGroup,
} from "@/lib/game/hand-ranking.mjs";
import { readPublicOnlineRound } from "@/lib/game/online-round.mjs";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { Tables } from "@/lib/supabase/database.types";

type Room = Tables<"game_rooms">;
type Member = Tables<"room_members">;

type HandsSnapshot = {
  roundToken: string | null;
  hands: Record<string, Card[]>;
};

const CARD_BY_IMAGE_ID = new Map(
  createDeck().map((card) => [card.imageId, card]),
);

function cardsFromIds(cardIds: number[]): Card[] | null {
  if (cardIds.length !== 2 || cardIds[0] === cardIds[1]) return null;
  const cards = cardIds.map((cardId) => CARD_BY_IMAGE_ID.get(cardId));
  return cards.every((card): card is Card => Boolean(card)) ? cards : null;
}

function exact(value: number | string | bigint): bigint {
  return typeof value === "bigint" ? value : BigInt(value);
}

function formatted(value: number | string | bigint): string {
  return exact(value).toLocaleString("ko-KR");
}

function serverErrorMessage(error: unknown): string {
  return error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message
    : "";
}

function isStaleRequest(error: unknown): boolean {
  return /stale room version/i.test(serverErrorMessage(error));
}

function isRoundRosterUnavailable(error: unknown): boolean {
  return /Every player must be online|Round players no longer match/i.test(
    serverErrorMessage(error),
  );
}

type Props = {
  room: Room;
  members: Member[];
  names: Record<string, string>;
  userId: string;
  onRefreshRoom: (roomId: string) => Promise<void>;
  onNotice: (message: string) => void;
  onReturnToMain: (message?: string) => void;
  onOpenLedger: () => void;
};

export default function OnlineRoomGame({
  room,
  members,
  names,
  userId,
  onRefreshRoom,
  onNotice,
  onReturnToMain,
  onOpenLedger,
}: Props) {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const lifecycleGenerationRef = useRef(0);
  const touchInFlightGenerationRef = useRef<number | null>(null);
  const expireInFlightGenerationRef = useRef<number | null>(null);
  const refreshInFlightRef = useRef<{
    generation: number;
    roomId: string;
    promise: Promise<void>;
  } | null>(null);
  const [raiseAmount, setRaiseAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [presenceNow, setPresenceNow] = useState(() => Date.now());
  const [handsSnapshot, setHandsSnapshot] = useState<HandsSnapshot>({
    roundToken: null,
    hands: {},
  });
  const round = readPublicOnlineRound(room.state);
  const roundToken = round?.roundToken ?? null;
  const roundPhase = round?.phase ?? null;
  const hands =
    round && handsSnapshot.roundToken === round.roundToken
      ? handsSnapshot.hands
      : {};
  const myHand = hands[userId];
  const myEvaluation = myHand ? evaluateHand(myHand) : null;
  const currentRankingGroup = myEvaluation
    ? handRankingGroup(myEvaluation.name)
    : null;
  const isMyTurn = Boolean(
    round?.phase === "betting" && round.betting.turnPlayerId === userId,
  );
  const onlinePlayerIds = useMemo(
    () =>
      new Set(
        members
          .filter(
            (member) =>
              presenceNow - Date.parse(member.last_seen_at) <= 60_000,
          )
          .map((member) => member.user_id),
      ),
    [members, presenceNow],
  );
  const allPlayersOnline = Boolean(
    round && round.playerIds.every((id) => onlinePlayerIds.has(id)),
  );

  const refreshLatest = useCallback(
    (
      failureNotice: string,
      generation = lifecycleGenerationRef.current,
    ): Promise<void> => {
      if (
        refreshInFlightRef.current?.generation === generation &&
        refreshInFlightRef.current.roomId === room.id
      ) {
        return refreshInFlightRef.current.promise;
      }

      const promise = onRefreshRoom(room.id)
        .catch(() => {
          if (lifecycleGenerationRef.current === generation) {
            onNotice(failureNotice);
          }
        })
        .finally(() => {
          if (refreshInFlightRef.current?.promise === promise) {
            refreshInFlightRef.current = null;
          }
        });
      refreshInFlightRef.current = {
        generation,
        roomId: room.id,
        promise,
      };
      return promise;
    },
    [onNotice, onRefreshRoom, room.id],
  );

  const touchPresence = useCallback(
    async (generation: number) => {
      if (!supabase) return;
      if (touchInFlightGenerationRef.current === generation) return;
      touchInFlightGenerationRef.current = generation;
      try {
        const { error } = await supabase.rpc("touch_room_presence", {
          target_room: room.id,
        });
        if (lifecycleGenerationRef.current !== generation) return;
        if (error) {
          await refreshLatest(
            "접속 상태를 갱신하지 못했어요. 최신 게임 상태를 다시 확인해 주세요.",
            generation,
          );
          return;
        }
        setPresenceNow(Date.now());
      } catch {
        if (lifecycleGenerationRef.current === generation) {
          await refreshLatest(
            "접속 상태를 갱신하지 못했어요. 최신 게임 상태를 다시 확인해 주세요.",
            generation,
          );
        }
      } finally {
        if (touchInFlightGenerationRef.current === generation) {
          touchInFlightGenerationRef.current = null;
        }
      }
    },
    [refreshLatest, room.id, supabase],
  );

  const expireIfIdle = useCallback(
    async (generation: number) => {
      if (!supabase) return;
      if (expireInFlightGenerationRef.current === generation) return;
      expireInFlightGenerationRef.current = generation;
      try {
        const { data, error } = await supabase.rpc("expire_idle_game_room", {
          target_room: room.id,
        });
        if (lifecycleGenerationRef.current !== generation) return;
        if (error) {
          await refreshLatest(
            "게임 종료 상태를 확인하지 못했어요. 최신 게임 상태를 다시 확인해 주세요.",
            generation,
          );
          return;
        }
        if (
          data !== null &&
          typeof data === "object" &&
          "expired" in data &&
          data.expired === true
        ) {
          onReturnToMain("2분 동안 게임 행동이 없어 게임이 자동 종료됐어요.");
        }
      } catch {
        if (lifecycleGenerationRef.current === generation) {
          await refreshLatest(
            "게임 종료 상태를 확인하지 못했어요. 최신 게임 상태를 다시 확인해 주세요.",
            generation,
          );
        }
      } finally {
        if (expireInFlightGenerationRef.current === generation) {
          expireInFlightGenerationRef.current = null;
        }
      }
    },
    [onReturnToMain, refreshLatest, room.id, supabase],
  );

  useEffect(() => {
    const generation = lifecycleGenerationRef.current + 1;
    lifecycleGenerationRef.current = generation;

    const touch = () => void touchPresence(generation);
    const expire = () => void expireIfIdle(generation);
    const foreground = () => {
      if (document.visibilityState !== "visible") return;
      touch();
      expire();
      void refreshLatest(
        "게임 상태를 새로고침하지 못했어요. 잠시 후 다시 시도해 주세요.",
        generation,
      );
    };

    touch();
    expire();
    const heartbeat = window.setInterval(touch, 20_000);
    const expiry = window.setInterval(expire, 10_000);
    document.addEventListener("visibilitychange", foreground);

    return () => {
      if (lifecycleGenerationRef.current === generation) {
        lifecycleGenerationRef.current += 1;
      }
      window.clearInterval(heartbeat);
      window.clearInterval(expiry);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [expireIfIdle, refreshLatest, touchPresence]);

  useEffect(() => {
    if (!supabase || !roundToken) return;

    let active = true;

    void supabase
      .from("game_round_hands")
      .select("player_id, card_ids")
      .eq("room_id", room.id)
      .eq("round_token", roundToken)
      .then(({ data, error }) => {
        if (!active) return;
        if (error) {
          onNotice("보이는 패를 불러오지 못했어요. 판 상태를 새로고침해 주세요.");
          return;
        }

        const nextHands: Record<string, Card[]> = {};
        for (const row of data ?? []) {
          const cards = cardsFromIds(row.card_ids);
          if (cards) nextHands[row.player_id] = cards;
        }
        setHandsSnapshot({ roundToken, hands: nextHands });
      });

    return () => {
      active = false;
    };
  }, [onNotice, room.id, room.version, roundPhase, roundToken, supabase]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const gameWindow = window as Window & {
      render_game_to_text?: () => string;
      advanceTime?: (milliseconds: number) => void;
    };
    gameWindow.render_game_to_text = () =>
      JSON.stringify({
        mode: "online",
        roundNumber: round?.roundNumber ?? null,
        phase: round?.phase ?? "waiting",
        myHandName: myEvaluation?.name ?? null,
        isMyTurn,
        currentStake: round ? String(round.betting.currentStake) : null,
        playerCount: round?.playerIds.length ?? 0,
      });
    gameWindow.advanceTime = (milliseconds: number) => {
      void milliseconds;
      return undefined;
    };
    return () => {
      delete gameWindow.render_game_to_text;
      delete gameWindow.advanceTime;
    };
  }, [isMyTurn, myEvaluation?.name, round]);

  async function submitAction(
    action:
      | { type: "call" }
      | { type: "raise"; amount: string }
      | { type: "fold" },
  ) {
    if (
      !supabase ||
      !round ||
      round.phase !== "betting" ||
      round.betting.turnPlayerId !== userId ||
      busy
    ) {
      return;
    }

    setBusy(true);
    try {
      const { error } = await supabase.rpc("play_game_action", {
        target_room: room.id,
        expected_version: room.version,
        action_name: action.type,
        raise_to: action.type === "raise" ? String(action.amount) : null,
      });
      if (error) {
        onNotice(
          isStaleRequest(error)
            ? "다른 계정의 행동이 먼저 반영됐어요. 최신 판으로 다시 맞췄습니다."
            : "행동이 서버에서 거절됐어요. 최신 판을 불러왔습니다.",
        );
      } else {
        setRaiseAmount("");
      }
      await refreshLatest(
        "행동 뒤 최신 판을 불러오지 못했어요. 잠시 후 다시 확인해 주세요.",
      );
    } catch {
      onNotice("행동을 처리하지 못했어요. 최신 판을 다시 불러와 주세요.");
      await refreshLatest(
        "행동 뒤 최신 판을 불러오지 못했어요. 잠시 후 다시 확인해 주세요.",
      );
    } finally {
      setBusy(false);
    }
  }

  function raise() {
    if (!round) return;
    if (!/^\d+$/.test(raiseAmount)) {
      onNotice("올릴 총 딱밤을 숫자로 입력해 주세요.");
      return;
    }
    if (exact(raiseAmount) <= exact(round.betting.currentStake)) {
      onNotice(`현재 ${formatted(round.betting.currentStake)}보다 큰 정수를 입력해 주세요.`);
      return;
    }
    void submitAction({ type: "raise", amount: raiseAmount });
  }

  async function startNextRound() {
    if (!supabase || !round || room.host_id !== userId || busy) return;
    if (!allPlayersOnline) {
      onNotice("참가자 접속을 확인할 수 없어 다음 판을 시작할 수 없어요.");
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase.rpc("start_game_round", {
        target_room: room.id,
        expected_version: room.version,
      });
      if (error) {
        const notice = isRoundRosterUnavailable(error)
          ? "참가자 접속을 확인할 수 없어 다음 판을 시작할 수 없어요."
          : isStaleRequest(error)
            ? "다른 기기에서 판이 먼저 바뀌었어요. 최신 상태로 다시 맞췄습니다."
            : "다음 판을 시작하지 못했어요. 최신 상태를 확인해 주세요.";
        onNotice(notice);
        await refreshLatest(notice);
        return;
      }
      await refreshLatest(
        "다음 판을 시작했지만 최신 상태를 불러오지 못했어요. 잠시 후 다시 확인해 주세요.",
      );
    } catch {
      onNotice("다음 판을 시작하지 못했어요. 잠시 후 다시 시도해 주세요.");
      await refreshLatest(
        "다음 판을 시작하지 못했어요. 잠시 후 다시 시도해 주세요.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function endGame() {
    if (!supabase || busy) return;
    setBusy(true);
    const notice = "게임을 끝내지 못했어요. 최신 상태를 확인해 주세요.";
    try {
      const { error } =
        room.host_id === userId
          ? await supabase.rpc("close_game_room", {
              target_room: room.id,
              expected_version: room.version,
            })
          : await supabase.rpc("leave_game_room", {
              target_room: room.id,
              expected_version: room.version,
            });
      if (error) {
        onNotice(notice);
        await refreshLatest(notice);
        return;
      }
      onReturnToMain("게임을 끝내고 메인으로 돌아왔어요.");
    } catch {
      onNotice(notice);
      await refreshLatest(notice);
    } finally {
      setBusy(false);
    }
  }

  if (!round) {
    return (
      <section className="onlineGame onlineGame--loading">
        <header className="onlineGame__topbar">
          <div>
            <small>방 {room.code}</small>
            <h2>딱밤 섯다</h2>
          </div>
          <div className="onlineGame__topActions">
            <button type="button" onClick={onOpenLedger}>
              딱밤 장부
            </button>
            <button type="button" disabled={busy} onClick={() => void endGame()}>게임 끝내기</button>
          </div>
        </header>
        <div className="onlineGame__loadingMessage" role="status">
          <strong>온라인 패를 준비하고 있어요</strong>
          <span>서버에서 최신 판 상태를 확인하는 중입니다.</span>
        </div>
      </section>
    );
  }

  const winnerText =
    round.winnerIds.length === 1
      ? `${names[round.winnerIds[0]] ?? "플레이어"} 승리`
      : "공동 1위 · 채무 없음";
  const myCardSlots: Array<Card | null> = myHand ?? [null, null];
  const opponents = round.playerIds.filter((playerId) => playerId !== userId);
  const isFolded = round.foldedPlayerIds.includes(userId);

  return (
    <section className="onlineGame" aria-labelledby="online-game-heading">
      <header className="onlineGame__topbar">
        <div>
          <small>방 {room.code} · {round.roundNumber}판</small>
          <h2 id="online-game-heading">딱밤 섯다</h2>
        </div>
        <strong>현재 {formatted(round.betting.currentStake)} 딱밤</strong>
        <div className="onlineGame__topActions">
          <button type="button" onClick={onOpenLedger}>
            딱밤 장부
          </button>
          <button type="button" disabled={busy} onClick={() => void endGame()}>게임 끝내기</button>
        </div>
      </header>

      <div className={`onlineGame__table onlineGame__table--${round.playerIds.length}`}>
        <div className={`onlineGame__opponents onlineGame__opponents--${opponents.length}`}>
          {opponents.map((playerId) => {
          const isTurn =
            round.phase === "betting" &&
            round.betting.turnPlayerId === playerId;
          const visibleCards =
            round.phase === "showdown" ? hands[playerId] : undefined;
          const cardSlots: Array<Card | null> = visibleCards ?? [null, null];
          const playerFolded = round.foldedPlayerIds.includes(playerId);
          const online = onlinePlayerIds.has(playerId);

          return (
            <article
              key={playerId}
              className={`${isTurn ? "is-turn" : ""} ${playerFolded ? "is-folded" : ""}`.trim()}
              aria-label={`${names[playerId] ?? "플레이어"} 자리`}
            >
              <div className="onlineGame__seatMeta">
                <strong>{names[playerId] ?? "플레이어"}</strong>
                <div className="onlineGame__badges">
                  <span className={online ? "is-online" : "is-offline"}>
                    {online ? "온라인" : "오프라인"}
                  </span>
                  {playerFolded && <span className="is-folded">죽음</span>}
                </div>
              </div>
              <div className="onlineGame__opponentCards">
                {cardSlots.map((card, index) => (
                  // Source artwork is served from the attributed local card set.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={card?.id ?? `back-${index}`}
                    src={card ? `/cards/${card.imageId}.png` : "/cards/back.png"}
                    width="76"
                    height="112"
                    alt={
                      card
                        ? `${names[playerId] ?? "상대"}의 ${card.month}월 패`
                        : "상대 패 뒷면"
                    }
                  />
                ))}
              </div>
              <small>
                {isTurn
                  ? "현재 차례"
                  : `받음 ${formatted(round.betting.commitments[playerId] ?? 0)}`}
              </small>
              {round.phase === "showdown" && (
                <b className="onlineGame__hand">
                  {round.evaluations[playerId]?.name}
                </b>
              )}
            </article>
          );
          })}
        </div>

        <article className={`onlineGame__me ${isFolded ? "is-folded" : ""}`}>
          <div className="onlineGame__meHeading">
            <span>내 패</span>
            <strong>{myEvaluation?.name ?? "패 확인 중"}</strong>
          </div>
          <div className="onlineGame__myCards">
            {myCardSlots.map((card, index) => (
              // Source artwork is served from the attributed local card set.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={card?.id ?? `my-back-${index}`}
                src={card ? `/cards/${card.imageId}.png` : "/cards/back.png"}
                width="132"
                height="194"
                alt={card ? `내 ${card.month}월 패` : "내 패 불러오는 중"}
              />
            ))}
          </div>
          {isFolded && <span className="onlineGame__foldBadge">이번 판 죽음</span>}
          {myEvaluation && (
            <details className="onlineGame__rankRollup">
              <summary>
                <strong>내 패 · {myEvaluation.name}</strong>
                <span>족보 보기</span>
              </summary>
              <div className="onlineGame__rankList">
                {COMPACT_HAND_RANKING.map((group) => (
                  <div
                    key={group.id}
                    className={currentRankingGroup === group.id ? "is-current" : ""}
                  >
                    <b>{group.label}</b>
                    <span>{group.summary}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </article>
      </div>

      <footer className="onlineGame__actionDock" aria-live="polite">
        {round.phase === "showdown" ? (
          <>
            <div className="onlineGame__result">
              <strong>{winnerText}</strong>
              <span>계정 장부 반영 완료</span>
            </div>
            {room.host_id === userId && (
              <div className="onlineGame__nextRound">
                {!allPlayersOnline && (
                  <span>참가자 접속을 확인할 수 없어 다음 판을 시작할 수 없어요.</span>
                )}
                <button
                  type="button"
                  disabled={busy || !allPlayersOnline}
                  onClick={() => void startNextRound()}
                >
                  다음 판
                </button>
              </div>
            )}
          </>
        ) : isMyTurn ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => void submitAction({ type: "call" })}
            >
              받기 <small>{formatted(round.betting.currentStake)}에 맞춤</small>
            </button>
            <label>
              올릴 총 딱밤
              <input
                value={raiseAmount}
                onChange={(event) => setRaiseAmount(event.target.value.trim())}
                inputMode="numeric"
                pattern="[0-9]*"
                placeholder={(exact(round.betting.currentStake) + BigInt(1)).toString()}
              />
            </label>
            <button type="button" disabled={busy} onClick={raise}>
              올리기
            </button>
            <button type="button" className="onlineGame__fold" disabled={busy} onClick={() => void submitAction({ type: "fold" })}>죽기</button>
          </>
        ) : (
          <span>
            {isFolded
              ? "이번 판 결과를 기다리는 중…"
              : `${names[round.betting.turnPlayerId ?? ""] ?? "다른 계정"}의 차례를 기다리는 중…`}
          </span>
        )}
      </footer>
    </section>
  );
}
