/*
 * Интеграция с Telegram Mini Apps.
 *
 * Оболочка держит только Telegram-часть: разворачивает окно, красит системные
 * панели, отдаёт iframe ровно безопасную зону и снимает свою заставку, когда
 * документ игры загрузился. Сама игра остаётся обычной web-сборкой Godot и
 * про Telegram ничего не знает — её можно открыть и в браузере напрямую.
 */
(function () {
	"use strict";

	var tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
	var params = new URLSearchParams(window.location.search);
	var root = document.documentElement;
	var frame = document.getElementById("game");
	var boot = document.getElementById("boot");
	var bootBar = document.getElementById("boot-bar");
	var bootFill = document.getElementById("boot-fill");
	var bootProgress = document.getElementById("boot-progress");
	var loadingTimer = 0;

	var BG = "#0b0d14";
	// Игра портретная; на десктопе Telegram окно и так узкое, а в браузере
	// полноэкранный режим не навязываем.
	var MOBILE_PLATFORMS = ["android", "ios"];
	var FULLSCREEN_DEFAULT = tg ? MOBILE_PLATFORMS.indexOf(tg.platform) !== -1 : false;
	var wantFullscreen =
		params.get("fullscreen") === "0" ? false :
		params.get("fullscreen") === "1" ? true :
		FULLSCREEN_DEFAULT;

	function insetValue(object, side) {
		return object && typeof object[side] === "number" ? object[side] : 0;
	}

	/*
	 * contentSafeAreaInset — то, что перекрывает интерфейс Telegram
	 * (шапка, кнопка закрытия, нижняя панель), safeAreaInset — вырез
	 * устройства. Берём максимум по каждой стороне: игра не должна
	 * оказаться ни под кнопкой, ни под «монобровью».
	 */
	function applyInsets() {
		if (!tg) {
			return;
		}
		var safe = tg.safeAreaInset || {};
		var content = tg.contentSafeAreaInset || {};
		var sides = ["top", "right", "bottom", "left"];
		for (var i = 0; i < sides.length; i++) {
			var side = sides[i];
			var value = Math.max(insetValue(safe, side), insetValue(content, side));
			root.style.setProperty("--inset-" + side, Math.max(0, value) + "px");
		}
	}

	function applyColors() {
		if (!tg) {
			return;
		}
		try {
			tg.setHeaderColor(BG);
		} catch (error) {
			/* старые клиенты не знают метода — не критично */
		}
		try {
			tg.setBackgroundColor(BG);
		} catch (error) {
			/* то же */
		}
		if (tg.isVersionAtLeast && tg.isVersionAtLeast("7.10")) {
			try {
				tg.setBottomBarColor(BG);
			} catch (error) {
				/* то же */
			}
		}
	}

	function configureTelegram() {
		if (!tg) {
			return;
		}

		tg.ready();
		try {
			tg.expand();
		} catch (error) {
			/* окно уже развёрнуто */
		}
		applyColors();
		applyInsets();

		if (tg.isVersionAtLeast && tg.isVersionAtLeast("7.7")) {
			try {
				tg.disableVerticalSwipes();
			} catch (error) {
				/* жест недоступен в этой версии клиента */
			}
		}

		if (tg.BackButton) {
			try {
				tg.BackButton.hide();
			} catch (error) {
				/* кнопки нет — и хорошо */
			}
		}

		if (wantFullscreen && tg.isVersionAtLeast && tg.isVersionAtLeast("8.0")) {
			try {
				tg.requestFullscreen();
			} catch (error) {
				/* останемся в обычном развёрнутом окне */
			}
			// Ориентацию не фиксируем: lockOrientation() запирает текущую,
			// а игра, открытая в ландшафте, осталась бы в нём навсегда.
			// Пользователь может повернуть телефон в портрет сам.
		}

		if (typeof tg.onEvent === "function") {
			tg.onEvent("safeAreaChanged", applyInsets);
			tg.onEvent("contentSafeAreaChanged", applyInsets);
			tg.onEvent("fullscreenChanged", applyInsets);
			tg.onEvent("viewportChanged", applyInsets);
			tg.onEvent("themeChanged", applyColors);
			tg.onEvent("fullscreenFailed", function () {
				// Клиент отказал в полном экране — безопасные зоны остаются
				// актуальными, просто обновим их ещё раз.
				applyInsets();
			});
		}
	}

	/*
	 * Godot рисует собственный экран загрузки (index.png и серый #242424).
	 * Перекрашиваем его в фон игры, чтобы не было вспышки чужого цвета.
	 * Доступ к document iframe возможен, потому что страницы одного origin;
	 * если браузер запретил — молча пропускаем.
	 */
	function styleGameDocument() {
		try {
			var doc = frame.contentDocument;
			if (!doc || !doc.head || doc.getElementById("tg-shell-style")) {
				return;
			}
			var style = doc.createElement("style");
			style.id = "tg-shell-style";
			style.textContent =
				"html,body{background:#0b0d14 !important;}" +
				"#status{background-color:#0b0d14 !important;}" +
				"#status-splash{filter:drop-shadow(0 0 28px rgba(217,164,65,.18));}";
			doc.head.appendChild(style);
		} catch (error) {
			/* чужой origin или документ ещё не готов */
		}
	}

	function showProgress(percent) {
		if (!bootBar || !bootFill || !bootProgress) {
			return;
		}
		bootBar.classList.add("determinate");
		bootFill.style.width = percent + "%";
		bootProgress.textContent = "Загрузка " + percent + "%";
	}

	function stopLoadingWatch() {
		if (loadingTimer) {
			window.clearInterval(loadingTimer);
			loadingTimer = 0;
		}
	}

	/*
	 * Держим заставку, пока Godot реально не начнёт игру, и читаем его
	 * прогресс из iframe (страницы одного origin). Так вместо немого
	 * спиннера видно «Загрузка 42%». Если доступ к документу запрещён или
	 * игра упала — заставку всё равно снимаем, чтобы показать ошибку.
	 */
	function watchLoading() {
		if (loadingTimer || !frame) {
			return;
		}
		var started = performance.now();
		loadingTimer = window.setInterval(function () {
			try {
				var doc = frame.contentDocument;
				// about:blank до начала загрузки: канваса ещё нет.
				if (!doc || !doc.getElementById("canvas")) {
					if (performance.now() - started > 30000) {
						hideBoot();
					}
					return;
				}
				styleGameDocument();
				if (!doc.getElementById("status")) {
					hideBoot(); // Godot убрал свой экран — игра пошла
					return;
				}
				var notice = doc.getElementById("status-notice");
				if (notice && notice.style.display !== "none" && notice.textContent.trim()) {
					hideBoot(); // показываем ошибку движка
					return;
				}
				var progress = doc.getElementById("status-progress");
				if (progress && progress.max > 0) {
					var percent = Math.round((progress.value / progress.max) * 100);
					if (isFinite(percent)) {
						showProgress(Math.max(0, Math.min(100, percent)));
					}
				}
			} catch (error) {
				/* другой origin — просто ждём загрузки */
			}
			if (performance.now() - started > 300000) {
				hideBoot(); // страховка: 5 минут — уже слишком долго
			}
		}, 200);
	}

	function hideBoot() {
		if (!boot || boot.classList.contains("hidden")) {
			return;
		}
		stopLoadingWatch();
		styleGameDocument();
		boot.classList.add("hidden");
		window.setTimeout(function () {
			if (boot.parentNode) {
				boot.parentNode.removeChild(boot);
			}
		}, 450);
	}

	configureTelegram();

	if (frame) {
		frame.addEventListener("load", watchLoading);
		// Скрипт подключён с defer: iframe мог успеть загрузиться раньше,
		// чем мы повесили обработчик. Тогда начинаем следить сразу.
		try {
			if (frame.contentDocument && frame.contentDocument.readyState === "complete") {
				watchLoading();
			}
		} catch (error) {
			/* документ ещё не готов — сработает load */
		}
		// Клик по оболочке возвращает фокус игре — на десктопе это нужно
		// для клавиатуры после переключения вкладок.
		document.getElementById("stage").addEventListener("pointerdown", function () {
			try {
				frame.focus();
			} catch (error) {
				/* не критично */
			}
		});
	}
}());
