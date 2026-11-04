export const browserStyles = String.raw`
:root {
  color-scheme: light dark;
  --canvas: #f6f6f8;
  --surface: #ffffff;
  --text: #23232b;
  --muted: #6a6a78;
  --rule: #e5e5ec;
  --accent: #6157ce;
  --focus: #756be3;
  --danger: #a12b32;
  --warning: #805b21;
  font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: var(--canvas);
  color: var(--text);
  font-synthesis: none;
  -webkit-font-smoothing: antialiased;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--canvas); color: var(--text); }
a { color: var(--accent); text-decoration: none; text-underline-offset: .2em; }
a:hover { text-decoration: underline; }
a:focus-visible, button:focus-visible { outline: 3px solid var(--focus); outline-offset: 4px; border-radius: 4px; }
.main:focus { outline: none; }
.skip-link { position: absolute; left: 1rem; top: -5rem; background: var(--surface); padding: .75rem; z-index: 10; }
.skip-link:focus { top: 1rem; }
.shell { max-width: 1080px; margin: auto; display: grid; grid-template-columns: 190px minmax(0, 680px); gap: 48px; padding: 48px 28px; }
.sidebar { position: sticky; top: 40px; align-self: start; }
.brand { display: flex; align-items: center; gap: 10px; font-size: 17px; font-weight: 750; letter-spacing: -.6px; color: var(--text); }
.brand-mark { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 10px; background: var(--text); color: var(--surface); font-size: 24px; letter-spacing: -2px; padding-right: 2px; }
.nav { display: grid; gap: .5rem; margin-top: 32px; }
.nav a { min-height: 44px; display: flex; align-items: center; padding: 0 12px; border-radius: 8px; font-size: 14px; font-weight: 600; color: var(--muted); }
.nav a:hover, .nav [aria-current=page] { background: var(--surface); color: var(--text); text-decoration: none; }
.main { min-width: 0; }
.main[aria-busy=true] { cursor: progress; }
.eyebrow, .meta, .handle, .action { font-size: 12px; line-height: 1.5; color: var(--muted); }
.eyebrow { font-size: 10px; letter-spacing: .14em; font-weight: 650; margin: 0 0 12px; }
.page-header { padding: 4px 0 26px; }
h1 { font-size: clamp(27px, 4vw, 36px); letter-spacing: -1.2px; line-height: 1.15; margin: 0 0 10px; overflow-wrap: anywhere; }
h2 { font-size: 16px; letter-spacing: -.3px; }
.lede { font-size: 14px; color: var(--muted); line-height: 1.65; margin: 0; overflow-wrap: anywhere; }
.collection { list-style: none; padding: 0; margin: 0; background: var(--surface); border: 1px solid var(--rule); border-radius: 14px; overflow: hidden; }
.collection > li + li { border-top: 1px solid var(--rule); }
.post { padding: 24px; min-width: 0; }
.main > .post { background: var(--surface); border: 1px solid var(--rule); border-radius: 14px; }
.identity { display: flex; flex-wrap: wrap; gap: 4px 9px; align-items: baseline; min-width: 0; }
.identity a { font-size: 14px; font-weight: 650; color: var(--text); overflow-wrap: anywhere; }
.handle { overflow-wrap: anywhere; }
.status-badge { display: inline-block; border: 1px solid var(--rule); border-radius: 5px; padding: 1px 5px; color: var(--muted); font-size: 10px; }
.post-text { font-size: 16px; line-height: 1.65; letter-spacing: -.15px; margin: 14px 0 16px; white-space: pre-wrap; overflow-wrap: anywhere; }
.post > .action { margin: 0 0 10px; font-size: 11px; }
.post-links { display: flex; flex-wrap: wrap; gap: 18px; margin-top: 16px; font-size: 12px; color: var(--muted); }
.post-links a { color: var(--muted); }
.post-links a:hover { color: var(--accent); }
.repost { padding: 20px 24px 24px; }
.repost > .action { margin: 0 0 12px; font-size: 11px; }
.repost .post { border: 1px solid var(--rule); border-radius: 10px; padding: 18px; }
.notice { border: 1px solid var(--rule); border-radius: 12px; background: var(--surface); padding: 20px; margin: 18px 0; }
.notice h2 { font-size: 14px; margin: 0 0 7px; }
.notice p { font-size: 13px; line-height: 1.65; margin: 6px 0 0; color: var(--muted); }
.participation { margin: 0 0 26px; border-left: 3px solid var(--accent); }
.participation p:last-child { margin-top: 12px; }
.notice-warning { color: var(--warning); }
.notice-danger { color: var(--danger); }
.profile { padding: 0 0 24px; }
.profile-description { font-size: 15px; line-height: 1.7; margin: 0 0 16px; }
.profile > p:last-child { font-size: 13px; }
.collection > .profile { padding: 24px; }
.tabs { display: flex; flex-wrap: wrap; gap: 20px; border-bottom: 1px solid var(--rule); margin-bottom: 20px; }
.tabs a { min-height: 44px; padding: 12px 0; font-size: 13px; color: var(--muted); }
.tabs [aria-current=page] { border-bottom: 2px solid var(--accent); font-weight: 650; color: var(--text); }
.thread, .thread ol { list-style: none; margin: 0; padding: 0; }
.thread { background: var(--surface); border: 1px solid var(--rule); border-radius: 14px; }
.thread ol { margin-left: 24px; padding-left: 0; border-left: 2px solid var(--rule); }
button { min-height: 44px; border: 1px solid var(--rule); border-radius: 8px; background: var(--surface); color: var(--text); padding: 10px 18px; font-family: inherit; font-size: 13px; font-weight: 600; line-height: 1.5; cursor: pointer; }
button:hover { border-color: var(--accent); }
button:disabled { opacity: .55; cursor: wait; }
.load-older { display: block; margin: 24px auto; }
.skeleton { height: 180px; margin: 24px 0; background: var(--surface); border: 1px solid var(--rule); border-radius: 14px; }
@media (max-width: 800px) {
  .shell { display: block; max-width: 700px; padding: 24px; }
  .sidebar { position: static; display: flex; align-items: center; justify-content: space-between; gap: 16px; border-bottom: 1px solid var(--rule); padding-bottom: 20px; margin-bottom: 28px; }
  .nav { display: flex; margin: 0; }
}
@media (max-width: 480px) {
  .shell { padding: 20px 16px; }
  .brand { font-size: 15px; gap: 8px; }
  .brand-mark { width: 28px; height: 28px; border-radius: 8px; font-size: 21px; }
  .nav a { font-size: 12px; padding: 0 8px; }
  .post, .repost { padding: 18px; }
  .repost .post { padding: 14px; }
  .thread ol { margin-left: 12px; }
  .thread .post { padding: 16px 12px; }
  .post-links { gap: 14px; }
}
@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; } }
@media (prefers-contrast: more) { :root { --rule: currentColor; } }
@media (prefers-color-scheme: dark) {
  :root { --canvas: #151518; --surface: #1d1d22; --text: #eeeeF2; --muted: #a0a0af; --rule: #303038; --accent: #aaa1ff; --focus: #b8b4ff; --danger: #ff9a9f; --warning: #e1bf85; }
}
`;
