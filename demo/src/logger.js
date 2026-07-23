/** Structured BLE log with level coloring and timing. */
let _el = null;
function getEl() {
    if (!_el)
        _el = document.getElementById('log');
    return _el;
}
export function log(level, msg, detail) {
    const t = new Date();
    const ts = t.getHours().toString().padStart(2, '0') + ':' +
        t.getMinutes().toString().padStart(2, '0') + ':' +
        t.getSeconds().toString().padStart(2, '0') + '.' +
        t.getMilliseconds().toString().padStart(3, '0');
    const el = getEl();
    const line = document.createElement('div');
    line.className = `entry ${level}`;
    line.innerHTML = `<span class="time">[${ts}]</span> ${esc(msg)}`;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
    const fn = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
    console[fn](`[${ts}] [${level.toUpperCase()}]`, msg, detail ?? '');
}
function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/** Hex dump helper (max 64 bytes). */
export function hex(bytes, label = '') {
    const max = Math.min(bytes.length, 64);
    const hexes = [];
    for (let i = 0; i < max; i++) {
        hexes.push(bytes[i].toString(16).padStart(2, '0'));
    }
    const s = hexes.join(' ');
    const trunc = bytes.length > 64 ? ` … (${bytes.length} total)` : '';
    return `${label} (${bytes.length}B) ${s}${trunc}`;
}
