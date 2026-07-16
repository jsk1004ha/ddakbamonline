import AccountRoomPanel from "@/components/account-room-panel";

export default function Home() {
  return (
    <main className="online-shell">
      <header className="online-shell__header">
        <div className="online-shell__identity">
          <a className="brand" href="#top" aria-label="딱밤온라인 홈">
            <span className="brand-seal" aria-hidden="true">딱</span>
            <span>
              <strong>딱밤온라인</strong>
              <small>DDAKBAM ONLINE · SEOUL</small>
            </span>
          </a>
          <p>2~4인 실시간 2장 섯다</p>
        </div>
        <div className="online-shell__actions" aria-label="접속 상태">
          <span className="online-shell__status">
            <i aria-hidden="true" /> 온라인 접속
          </span>
        </div>
      </header>

      <section className="online-shell__main" id="top">
        <AccountRoomPanel />
      </section>

      <footer className="site-footer">
        <span>실제 금전이 오가지 않는 친선 게임입니다.</span>
        <span>© 2026 DDAKBAM ONLINE</span>
      </footer>
    </main>
  );
}
