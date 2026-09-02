import { Link } from "react-router-dom";
export function NotFoundScreen() { return <div className="page center-state"><div className="empty-glyph">404</div><h1>画面が見つかりません</h1><Link className="button primary" to="/library">ライブラリへ</Link></div>; }
