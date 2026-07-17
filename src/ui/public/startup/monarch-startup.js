export class MonarchStartup {
    root = null;
    statusElement = null;
    progressElement = null;
    progressValueElement = null;
    progress = 0;
    mountedAt = 0;
    autoProgressTimer = null;
    isCompleted = false;
    options;
    constructor(options = {}) {
        this.options = {
            title: options.title ?? "MONARCH",
            subtitle: options.subtitle ?? "Local Intelligence Environment",
            initialStatus: options.initialStatus ?? "Инициализация ядра",
            autoProgress: options.autoProgress ?? true,
            minimumVisibleTime: options.minimumVisibleTime ?? 1800,
        };
    }
    mount() {
        if (this.root || this.isCompleted) {
            return;
        }
        if (!document.body) {
            window.addEventListener("DOMContentLoaded", () => this.mount(), {
                once: true,
            });
            return;
        }
        this.mountedAt = performance.now();
        const root = document.createElement("div");
        root.id = "monarch-startup";
        root.setAttribute("role", "status");
        root.setAttribute("aria-live", "polite");
        root.setAttribute("aria-label", "Monarch запускается");
        root.innerHTML = `
      <div class="monarch-startup__background" aria-hidden="true">
        <div class="monarch-startup__glow monarch-startup__glow--left"></div>
        <div class="monarch-startup__glow monarch-startup__glow--right"></div>
        <div class="monarch-startup__grid"></div>
        <div class="monarch-startup__noise"></div>
      </div>

      <div class="monarch-startup__scan-line" aria-hidden="true"></div>

      <main class="monarch-startup__content">
        <div class="monarch-startup__emblem" aria-hidden="true">
          <div class="monarch-startup__emblem-aura"></div>

          <svg
            class="monarch-startup__logo"
            viewBox="0 0 180 180"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <circle
              class="monarch-startup__orbit monarch-startup__orbit--outer"
              cx="90"
              cy="90"
              r="72"
            />

            <circle
              class="monarch-startup__orbit monarch-startup__orbit--inner"
              cx="90"
              cy="90"
              r="58"
            />

            <path
              class="monarch-startup__wing monarch-startup__wing--left"
              d="M82 85C65 57 38 49 27 64C17 78 34 103 72 110C54 119 47 135 57 143C70 153 85 129 90 105"
            />

            <path
              class="monarch-startup__wing monarch-startup__wing--right"
              d="M98 85C115 57 142 49 153 64C163 78 146 103 108 110C126 119 133 135 123 143C110 153 95 129 90 105"
            />

            <path
              class="monarch-startup__monogram"
              d="M58 111V67L90 94L122 67V111"
            />

            <path
              class="monarch-startup__monogram-detail"
              d="M58 67L76 81L90 58L104 81L122 67"
            />

            <circle
              class="monarch-startup__core-ring"
              cx="90"
              cy="98"
              r="9"
            />

            <circle
              class="monarch-startup__core"
              cx="90"
              cy="98"
              r="3.5"
            />
          </svg>

          <div class="monarch-startup__pulse"></div>
        </div>

        <div class="monarch-startup__identity">
          <h1 class="monarch-startup__title">
            ${this.createAnimatedTitle(this.options.title)}
          </h1>

          <p class="monarch-startup__subtitle">
            ${this.escapeHtml(this.options.subtitle)}
          </p>
        </div>

        <div class="monarch-startup__boot">
          <div class="monarch-startup__status-row">
            <div class="monarch-startup__status">
              <span class="monarch-startup__status-indicator"></span>
              <span data-monarch-status>
                ${this.escapeHtml(this.options.initialStatus)}
              </span>
            </div>

            <span class="monarch-startup__progress-value" data-monarch-progress-value>
              0%
            </span>
          </div>

          <div class="monarch-startup__progress-track">
            <div
              class="monarch-startup__progress-bar"
              data-monarch-progress
            ></div>
            <div class="monarch-startup__progress-shine"></div>
          </div>
        </div>
      </main>

      <div class="monarch-startup__version">
        SYSTEM STARTUP · OSCAR CORE
      </div>
    `;
        document.body.appendChild(root);
        this.root = root;
        this.statusElement = root.querySelector("[data-monarch-status]");
        this.progressElement = root.querySelector("[data-monarch-progress]");
        this.progressValueElement = root.querySelector("[data-monarch-progress-value]");
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                root.classList.add("monarch-startup--visible");
            });
        });
        if (this.options.autoProgress) {
            this.startAutoProgress();
        }
    }
    setStatus(status) {
        if (!this.statusElement || this.isCompleted) {
            return;
        }
        this.statusElement.classList.remove("monarch-startup__status-text--change");
        requestAnimationFrame(() => {
            if (!this.statusElement) {
                return;
            }
            this.statusElement.textContent = status;
            this.statusElement.classList.add("monarch-startup__status-text--change");
        });
    }
    setProgress(value) {
        if (this.isCompleted) {
            return;
        }
        this.progress = Math.min(1, Math.max(this.progress, value));
        if (this.progressElement) {
            this.progressElement.style.transform = `scaleX(${this.progress})`;
        }
        if (this.progressValueElement) {
            this.progressValueElement.textContent =
                `${Math.round(this.progress * 100)}%`;
        }
    }
    async complete(finalStatus = "Monarch готов") {
        if (this.isCompleted) {
            return;
        }
        this.isCompleted = true;
        this.stopAutoProgress();
        this.progress = 1;
        if (this.progressElement) {
            this.progressElement.style.transform = "scaleX(1)";
        }
        if (this.progressValueElement) {
            this.progressValueElement.textContent = "100%";
        }
        if (this.statusElement) {
            this.statusElement.textContent = finalStatus;
        }
        this.root?.classList.add("monarch-startup--ready");
        const elapsed = performance.now() - this.mountedAt;
        const remainingTime = Math.max(0, this.options.minimumVisibleTime - elapsed);
        await this.delay(remainingTime + 350);
        this.root?.classList.add("monarch-startup--leaving");
        await this.delay(this.prefersReducedMotion() ? 100 : 900);
        this.destroy();
    }
    fail(message = "Ошибка запуска") {
        this.stopAutoProgress();
        this.root?.classList.add("monarch-startup--error");
        if (this.statusElement) {
            this.statusElement.textContent = message;
        }
        if (this.progressValueElement) {
            this.progressValueElement.textContent = "ERROR";
        }
    }
    destroy() {
        this.stopAutoProgress();
        this.root?.remove();
        this.root = null;
        this.statusElement = null;
        this.progressElement = null;
        this.progressValueElement = null;
    }
    startAutoProgress() {
        const statusStages = [
            { threshold: 0.15, text: "Запуск системных модулей" },
            { threshold: 0.32, text: "Подключение памяти" },
            { threshold: 0.48, text: "Проверка Monarch Security" },
            { threshold: 0.63, text: "Инициализация Oscar" },
            { threshold: 0.76, text: "Подготовка интерфейса" },
        ];
        let activeStage = -1;
        this.autoProgressTimer = window.setInterval(() => {
            if (this.isCompleted) {
                this.stopAutoProgress();
                return;
            }
            const remaining = 0.86 - this.progress;
            if (remaining <= 0.002) {
                return;
            }
            const increment = Math.max(0.0015, remaining * (0.025 + Math.random() * 0.035));
            this.setProgress(Math.min(0.86, this.progress + increment));
            let nextStage = -1;
            for (let index = statusStages.length - 1; index >= 0; index -= 1) {
                if (this.progress >= statusStages[index].threshold) {
                    nextStage = index;
                    break;
                }
            }
            if (nextStage > activeStage) {
                activeStage = nextStage;
                this.setStatus(statusStages[nextStage].text);
            }
        }, 90);
    }
    stopAutoProgress() {
        if (this.autoProgressTimer !== null) {
            window.clearInterval(this.autoProgressTimer);
            this.autoProgressTimer = null;
        }
    }
    createAnimatedTitle(title) {
        return [...title]
            .map((character, index) => {
            const safeCharacter = character === " " ? "&nbsp;" : this.escapeHtml(character);
            return `
          <span
            class="monarch-startup__letter"
            style="--letter-index: ${index}"
          >
            ${safeCharacter}
          </span>
        `;
        })
            .join("");
    }
    escapeHtml(value) {
        const element = document.createElement("div");
        element.textContent = value;
        return element.innerHTML;
    }
    delay(milliseconds) {
        return new Promise((resolve) => {
            window.setTimeout(resolve, milliseconds);
        });
    }
    prefersReducedMotion() {
        return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    }
}
