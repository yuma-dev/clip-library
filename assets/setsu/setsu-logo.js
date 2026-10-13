// Setsu logo component. Usage:
//   const logo = new SetsuLogo(document.querySelector("#logo"), { size: 160 });
//   await logo.reveal({ name: true });   // Q6 reveal, then the name comes out, then the L7 loop
//   await logo.showName(); await logo.hideName(); await logo.hide();
//   logo.show({ name: false });          // finished state, no reveal
// Every transition is a class on the root (.reveal, .name-in, .name-out, .exit); base styles are the finished logo.
(function () {
  const T = { revealEnd: 3050, nameAt: 2850, nameIn: 1250, nameOut: 1100, exit: 1000 };
  const part = (c) => `<div class="pt ${c}"><div class="E"><div class="R"><div class="P"><i></i></div></div></div></div>`;
  const tiles = [...Array(9)].map((_, i) => {
    const gx = i % 3, gy = (i / 3) | 0, r = Math.abs(gx - 1) + Math.abs(gy - 1);
    return `<div class="tc t${i}" style="--gx:${gx};--gy:${gy};--d:${gx + gy};--r:${r}"><div class="tv"><div class="ti"><i class="tth"></i><i class="tp"></i></div></div></div>`;
  }).join("");
  const MARK = `<div class="mark">
    <div class="x tiles">${tiles}</div><i class="x shadow"></i>
    <div class="mE"><div class="mR"><div class="mP">${["glow", "c tl", "c tr", "c br", "c bl", "star"].map(part).join("")}</div></div></div>
    <div class="x cursor"><div class="cx"><div class="cy"><div class="cp"><svg viewBox="0 0 24 24"><path d="M5 3 L5 19.5 L9.6 15.2 L12.6 21.6 L15.3 20.4 L12.4 14.1 L18.6 13.9 Z"/></svg></div></div></div></div>
    <i class="x clickfx"></i><i class="x ring"></i><i class="x flare"></i></div>`;
  const WORD = `<div class="wordbox"><div class="wordwrap"><div class="word">${[..."SETSU"].map((c, i) => `<span style="--i:${i}">${c}</span>`).join("")}</div></div></div>`;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  class SetsuLogo {
    constructor(root, { size } = {}) {
      this.el = root;
      root.classList.add("setsu");
      if (size) root.style.setProperty("--s", size + "px");
      root.innerHTML = `<div class="lockup">${MARK}${WORD}</div>`;
      this.state = "hidden";
      this.token = 0;
      this.el.classList.add("exit", "gone");
      this.ready = document.fonts.load('500 40px "Setsu Unbounded"').catch(() => {}).then(() => this.measure());
      addEventListener("resize", () => { this.measure(); this.snap(); });
    }
    measure() {
      const dpr = devicePixelRatio || 1;
      this.el.style.setProperty("--dpx", 1 / dpr + "px");
      const lk = this.el.querySelector(".lockup"), wb = this.el.querySelector(".wordbox");
      const gap = parseFloat(getComputedStyle(lk).columnGap) || 0;
      this.el.style.setProperty("--shift", (wb.offsetWidth + gap) / 2 + "px");
    }
    // the tile grid must start on a whole device pixel or its gaps round unevenly
    snap() {
      const t = this.el.querySelector(".tiles"), dpr = devicePixelRatio || 1;
      t.style.translate = "";
      const r = t.getBoundingClientRect();
      t.style.translate = `${Math.round(r.x * dpr) / dpr - r.x}px ${Math.round(r.y * dpr) / dpr - r.y}px`;
    }
    set(...cls) { // restart: drop transition classes, reflow, add the new ones
      this.el.classList.remove("reveal", "name-in", "name-out", "exit", "gone");
      void this.el.offsetWidth;
      this.el.classList.add(...cls);
    }
    async reveal({ name = false } = {}) {
      await this.ready;
      const tk = ++this.token;
      this.el.classList.remove("named", "loop");
      this.set("reveal");
      this.snap();
      this.state = "revealing";
      if (name) {
        await wait(T.nameAt); if (tk !== this.token) return;
        this.el.classList.add("named", "name-in");
        await wait(T.revealEnd - T.nameAt); if (tk !== this.token) return;
        this.el.classList.add("loop");
        await wait(T.nameIn - (T.revealEnd - T.nameAt)); if (tk !== this.token) return;
      } else {
        await wait(T.revealEnd); if (tk !== this.token) return;
        this.el.classList.add("loop");
      }
      this.el.classList.remove("reveal", "name-in");
      this.state = name ? "lockup" : "icon";
    }
    show({ name = false } = {}) {
      this.token++;
      this.set();
      this.el.classList.toggle("named", name);
      this.el.classList.add("loop");
      this.state = name ? "lockup" : "icon";
    }
    async showName() {
      if (this.state !== "icon") return;
      const tk = ++this.token;
      this.el.classList.add("named");
      this.set("name-in");
      this.state = "lockup";
      await wait(T.nameIn); if (tk === this.token) this.el.classList.remove("name-in");
    }
    async hideName() {
      if (this.state !== "lockup") return;
      const tk = ++this.token;
      this.set("name-out");
      this.state = "icon";
      await wait(T.nameOut); if (tk !== this.token) return;
      this.el.classList.remove("name-out", "named");
    }
    async hide() {
      if (this.state === "hidden") return;
      const tk = ++this.token;
      this.set("exit");
      this.state = "hidden";
      await wait(T.exit); if (tk !== this.token) return;
      this.el.classList.remove("loop", "named");
      this.el.classList.add("gone");
    }
  }
  SetsuLogo.timing = T;
  window.SetsuLogo = SetsuLogo;
})();
