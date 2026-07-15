"use client";

import { useEffect, useMemo, useState } from "react";

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

function isStaleRequest(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "message" in error &&
      typeof error.message === "string" &&
      /stale room version/i.test(error.message),
  );
}

type Props = {
  room: Room;
  names: Record<string, string>;
  userId: string;
  onRefreshRoom: (roomId: string) => Promise<void>;
  onNotice: (message: string) => void;
};

export default function OnlineRoomGame({
  room,
  names,
  userId,
  onRefreshRoom,
  onNotice,
}: Props) {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const [raiseAmount, setRaiseAmount] = useState("");
  const [busy, setBusy] = useState(false);
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
    action: { type: "call" } | { type: "raise"; amount: string },
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
      await onRefreshRoom(room.id);
    } catch {
      onNotice("행동을 처리하지 못했어요. 최신 판을 다시 불러와 주세요.");
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
    setBusy(true);
    try {
      const { error } = await supabase.rpc("start_game_round", {
        target_room: room.id,
        expected_version: room.version,
      });
      if (error) {
        onNotice(
          isStaleRequest(error)
            ? "다른 기기에서 판이 먼저 바뀌었어요. 최신 상태로 다시 맞췄습니다."
            : "다음 판을 시작하지 못했어요. 최신 상태를 확인해 주세요.",
        );
      }
      await onRefreshRoom(room.id);
    } catch {
      onNotice("다음 판을 시작하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  if (!round) {
    return (
      <section className="onlineGame onlineGame--loading">
        <strong>온라인 패를 준비하고 있어요</strong>
        <span>방장이 판을 시작하면 서버가 2~4개 계정에 패를 배분합니다.</span>
        <OnlineStyles />
      </section>
    );
  }

  const winnerText =
    round.winnerIds.length === 1
      ? `${names[round.winnerIds[0]] ?? "플레이어"} 승리`
      : "공동 1위 · 채무 없음";

  return (
    <section className="onlineGame" aria-labelledby="online-game-heading">
      <header>
        <div>
          <small>REALTIME TABLE · ROUND {round.roundNumber}</small>
          <h3 id="online-game-heading">계정 방 실전판</h3>
        </div>
        <span>
          {round.phase === "betting"
            ? `판 딱밤 ${formatted(round.betting.currentStake)}`
            : winnerText}
        </span>
      </header>

      <div className={`onlineGame__seats onlineGame__seats--${round.playerIds.length}`}>
        {round.playerIds.map((playerId) => {
          const isTurn =
            round.phase === "betting" &&
            round.betting.turnPlayerId === playerId;
          const visibleCards =
            playerId === userId || round.phase === "showdown"
              ? hands[playerId]
              : undefined;
          const cardSlots: Array<Card | null> = visibleCards ?? [null, null];

          return (
            <article key={playerId} className={isTurn ? "is-turn" : ""}>
              <div>
                <strong>
                  {names[playerId] ?? "플레이어"}
                  {playerId === userId ? " · 나" : ""}
                </strong>
                <small>
                  {isTurn
                    ? "현재 차례"
                    : `받음 ${formatted(round.betting.commitments[playerId] ?? 0)}`}
                </small>
              </div>
              <div className="onlineGame__cards">
                {cardSlots.map((card, index) => (
                  // Source artwork is served from the attributed local card set.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={card?.id ?? `back-${index}`}
                    src={card ? `/cards/${card.imageId}.png` : "/cards/back.png"}
                    width="72"
                    height="106"
                    alt={card ? `${card.month}월 패` : "뒤집힌 패"}
                  />
                ))}
              </div>
              {playerId === userId && myEvaluation && (
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
              {round.phase === "showdown" && (
                <b className="onlineGame__hand">
                  {round.evaluations[playerId]?.name}
                </b>
              )}
            </article>
          );
        })}
      </div>

      <div className="onlineGame__actions" aria-live="polite">
        {round.phase === "showdown" ? (
          <>
            <div>
              <strong>{winnerText}</strong>
              <span>계정 장부 반영 완료</span>
            </div>
            {room.host_id === userId && (
              <button type="button" disabled={busy} onClick={() => void startNextRound()}>
                다음 판
              </button>
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
          </>
        ) : (
          <span>
            {names[round.betting.turnPlayerId ?? ""] ?? "다른 계정"}의 차례를 기다리는 중…
          </span>
        )}
      </div>
      <p className="onlineGame__privacy">
        각 화면에는 자기 패만 먼저 보이며, 쇼다운 때 전부 공개됩니다.
      </p>
      <OnlineStyles />
    </section>
  );
}

function OnlineStyles() {
  return <style jsx global>{`
    .onlineGame{margin-top:15px;padding:15px;border:1px solid rgba(211,164,86,.28);border-radius:16px;background:radial-gradient(circle at 50% 45%,#17443b,#0c211e 64%,#091512);color:#f7ecd8}.onlineGame--loading{display:flex;flex-direction:column;gap:4px}.onlineGame--loading span,.onlineGame__privacy{color:#8fa49c;font-size:11px}.onlineGame>header{display:flex;justify-content:space-between;align-items:center;gap:12px}.onlineGame>header small{color:#d9a553;font-size:9px;letter-spacing:.13em}.onlineGame>header h3{margin:3px 0 0}.onlineGame>header>span{padding:7px 9px;border-radius:9px;background:#081613;color:#ffdca5;font-size:11px;font-weight:800}
    .onlineGame__seats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:12px}.onlineGame__seats article{display:grid;grid-template-columns:1fr auto;gap:7px;padding:9px;border:1px solid #2f5148;border-radius:12px;background:rgba(6,20,17,.72)}.onlineGame__seats article.is-turn{border-color:#e0a657;box-shadow:0 0 0 2px rgba(224,166,87,.13)}.onlineGame__seats article strong{display:block;font-size:11px}.onlineGame__seats article small{color:#8ba097;font-size:9px}.onlineGame__cards{grid-column:2;grid-row:1/3;display:flex}.onlineGame__cards img{width:38px;height:56px;object-fit:cover;border-radius:4px;border:1px solid #d2bd94;box-shadow:0 4px 9px rgba(0,0,0,.3)}.onlineGame__cards img+img{margin-left:-14px;transform:rotate(3deg)}.onlineGame__hand{align-self:end;color:#f0b75f;font-size:11px}
    .onlineGame__actions{display:flex;align-items:end;gap:7px;margin-top:10px;padding:10px;border-radius:12px;background:#071411}.onlineGame__actions>span{color:#b3c2bc;font-size:12px}.onlineGame__actions>div{margin-right:auto}.onlineGame__actions>div strong,.onlineGame__actions>div span{display:block}.onlineGame__actions>div span{color:#91a49d;font-size:9px}.onlineGame__actions button{min-height:39px;padding:7px 12px;border:1px solid #db9d4e;border-radius:9px;background:linear-gradient(#db9d4e,#a9662c);color:#21160c;font-weight:900}.onlineGame__actions button small{display:block;font-size:8px}.onlineGame__actions button:disabled{opacity:.45}.onlineGame__actions label{color:#9dafaa;font-size:9px}.onlineGame__actions input{display:block;width:125px;margin-top:4px;padding:9px;border:1px solid #3c554e;border-radius:8px;background:#10231f;color:#fff}.onlineGame__actions input:focus{outline:2px solid #e0a657;outline-offset:1px}.onlineGame__privacy{margin:8px 0 0;text-align:center}
    @media(max-width:560px){.onlineGame__seats{grid-template-columns:1fr}.onlineGame__actions{align-items:stretch;flex-wrap:wrap}.onlineGame__actions label{flex:1}.onlineGame__actions input{width:100%;box-sizing:border-box}}
  `}</style>;
}
