export const browserPageStyles = String.raw`
:root{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#192b32;background:#f4f6f5;line-height:1.55;color-scheme:light}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0}
header{background:#fff;border-bottom:1px solid #dbe3df;padding:1rem clamp(1rem,4vw,3rem);display:flex;gap:1rem;align-items:center;justify-content:space-between}
.brand{font-weight:750;letter-spacing:.06em;color:#22584a}
.language-switcher{display:flex;gap:.35rem;align-items:center}
.language-switcher button{background:transparent;color:#22584a;padding:.35rem .55rem;min-height:2.25rem}
.language-switcher button[aria-pressed=true]{background:#e1ede7;font-weight:700}
main{max-width:1100px;margin:2rem auto;padding:0 1rem}
.login{max-width:440px;margin:8vh auto}
.panel{background:white;border:1px solid #dbe3df;border-radius:12px;padding:1.5rem;margin:1rem 0}
h1{font-size:1.75rem;line-height:1.3;margin:.3rem 0 1rem}
h2{font-size:1.2rem;margin:0 0 1rem}
h3{font-size:1rem;margin:0 0 .75rem}
p{margin:.5rem 0 1rem}
.muted,small{color:#536761}
label{display:block;font-weight:600;margin:.75rem 0 .25rem}
input,select,button,textarea{font:inherit}
input,select,textarea{border:1px solid #aabbb4;border-radius:6px;padding:.6rem;background:#fff;color:inherit;max-width:100%;width:100%;min-height:2.65rem}
input[type=checkbox]{width:1.1rem;min-height:1.1rem;vertical-align:middle}
button{border:1px solid transparent;border-radius:6px;padding:.6rem 1rem;min-height:2.65rem;background:#22584a;color:#fff;cursor:pointer}
button:disabled{opacity:.5;cursor:wait}
button.secondary{background:#edf2ef;color:#244f42;border-color:#c4d3cb}
button.danger{background:#9d3535}
button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #d09c46;outline-offset:2px}
.error{color:#9d2828}
.notice{padding:.8rem 1rem;background:#eaf2ed;border-radius:6px}
.actions{display:flex;gap:.6rem;flex-wrap:wrap;align-items:center;margin-top:1rem}
.row{display:flex;gap:1rem;align-items:flex-start;flex-wrap:wrap}
.row>*{flex:1;min-width:160px}
.check{display:flex;gap:.5rem;align-items:center;font-weight:400}
.check input{flex:none}
.subpanel{padding:1rem;border:1px solid #dbe3df;border-radius:8px;margin:.75rem 0}
.tabs{display:flex;flex-wrap:wrap;gap:.4rem}
.tabs button{background:transparent;color:#365d50;border-color:#c4d3cb}
.tabs button[aria-selected=true]{background:#22584a;color:white}
.summary{white-space:pre-wrap;overflow-wrap:anywhere}
.table-wrap{overflow:auto}
table{border-collapse:collapse;width:100%;text-align:left}
th,td{border-bottom:1px solid #e0e7e3;padding:.65rem;vertical-align:top}
dialog{max-width:min(620px,95vw);border:1px solid #aabbb4;border-radius:12px;padding:1.5rem;color:inherit}
dialog::backdrop{background:#192b3266}
.step{display:inline-block;border-radius:30px;background:#e1ede7;padding:.2rem .7rem;font-size:.85rem}
details>summary{cursor:pointer;font-weight:600}
pre{white-space:pre-wrap}
.empty{padding:1rem;color:#536761}
.identity{overflow-wrap:anywhere}
@media(max-width:600px){main{margin:1rem auto}
.panel{padding:1rem}
header{flex-wrap:wrap}
.row{display:block}
.row>*{margin:.5rem 0}
h1{font-size:1.5rem}
}
`;
