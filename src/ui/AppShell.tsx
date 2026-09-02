import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";

export function AppShell() {
  const [collapsed, setCollapsed] = useState(false);
  return <div className={`app-frame ${collapsed ? "nav-collapsed" : ""}`}>
    <aside className="side-nav" aria-label="メインナビゲーション">
      <div className="brand"><img src="/logo.PNG" alt="P.N.E." /><span>PC PLAYER</span></div>
      <nav>
        <NavLink to="/library" end><span aria-hidden>◈</span><b>ライブラリ</b></NavLink>
        <NavLink to="/afureco"><span aria-hidden>♩</span><b>アフレコ</b></NavLink>
        <NavLink to="/authoring"><span aria-hidden>✎</span><b>制作</b></NavLink>
        <NavLink to="/settings"><span aria-hidden>⌘</span><b>設定</b></NavLink>
        <NavLink to="/diagnostics"><span aria-hidden>◎</span><b>診断</b></NavLink>
      </nav>
      <button className="collapse-button" onClick={() => setCollapsed((value) => !value)} aria-label={collapsed ? "ナビを広げる" : "ナビを畳む"}>{collapsed ? "›" : "‹"}</button>
      <div className="privacy-mini"><i /> <span>名前データは<br />このPC内だけ</span></div>
    </aside>
    <main className="app-main"><Outlet /></main>
  </div>;
}
