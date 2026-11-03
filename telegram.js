/*
 * Интеграция с Telegram Mini Apps.
 *
 * Оболочка держит только Telegram-часть: разворачивает окно, красит системные
 * панели, отдаёт iframe ровно безопасную зону и снимает свою заставку, когда
 * документ игры загрузился. Игра остаётся обычной web-сборкой Godot: без
 * initData она работает офлайн, как в обычном браузере.
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
	var bootMiner = document.getElementById("boot-miner");
	var loadingTimer = 0;
	var currentPercent = 0;
	var finishing = false;
	// Подсказка, если прогресс замер: на телефоне движок может десятки секунд
	// собирать wasm, и полоса стоит на месте — это не зависание.
	var lastShownPercent = -1;
	var lastProgressAt = 0;
	var slowHintShown = false;

	var BG = "#0b0d14";
	// Игра портретная; на десктопе Telegram окно и так узкое, а в браузере
	// полноэкранный режим не навязываем.
	var MOBILE_PLATFORMS = ["android", "ios"];
	var FULLSCREEN_DEFAULT = tg ? MOBILE_PLATFORMS.indexOf(tg.platform) !== -1 : false;
	var wantFullscreen =
		params.get("fullscreen") === "0" ? false :
		params.get("fullscreen") === "1" ? true :
		FULLSCREEN_DEFAULT;
	// ?bootdemo=1 — остановить заставку для локальной проверки анимации.
	var bootDemo = params.get("bootdemo") === "1";

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

	/*
	 * initData — удостоверение пользователя для бэкенда. Оболочка и iframe
	 * одного origin, поэтому игра читает строку из sessionStorage. В логи
	 * и URL она не попадает. ?tgdebug=1 не стирает тестовую строку.
	 */
	function rememberInitData() {
		try {
			if (tg && tg.initData) {
				sessionStorage.setItem("darklode_init_data", tg.initData);
			} else if (!/[?&]tgdebug=1(?:&|$)/.test(window.location.search)) {
				sessionStorage.removeItem("darklode_init_data");
			}
		} catch (error) {
			/* приватный режим или отключённое хранилище */
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
		rememberInitData();
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
				"#status-splash{filter:drop-shadow(0 0 28px rgba(217,164,65,.18));}" +
				// Штатный прогресс Godot синий и спорит с янтарной картиной:
				// перекрашиваем его в акцент игры.
				"#status-progress{accent-color:#d9a441;}" +
				"#status-progress::-webkit-progress-value{background:#d9a441;}" +
				"#status-progress::-webkit-progress-bar{background:rgba(217,164,65,.18);}";
			doc.head.appendChild(style);
		} catch (error) {
			/* чужой origin или документ ещё не готов */
		}
	}

	function positionMiner(percent) {
		if (!bootBar || !bootMiner) {
			return;
		}
		var track = bootBar.clientWidth;
		var miner = bootMiner.offsetWidth;
		var max = Math.max(0, track - miner);
		bootMiner.style.transform = "translateX(" + (percent / 100) * max + "px)";
	}

	function setProgress(percent) {
		if (!bootBar || !bootFill || !bootProgress) {
			return;
		}
		currentPercent = Math.max(0, Math.min(100, percent));
		var shown = Math.round(currentPercent);
		if (shown !== lastShownPercent) {
			lastShownPercent = shown;
			lastProgressAt = performance.now();
			slowHintShown = false;
		}
		bootFill.style.width = currentPercent + "%";
		bootProgress.textContent =
			currentPercent > 0 ? "Загрузка " + shown + "%" : "Загрузка…";
		if (!slowHintShown && currentPercent < 100 && lastProgressAt > 0 &&
				performance.now() - lastProgressAt > 20000) {
			slowHintShown = true;
			bootProgress.textContent = "Загрузка " + shown +
				"% · готовим игру, это может занять минуту";
		}
		positionMiner(currentPercent);
		if (currentPercent >= 100) {
			finishBoot();
		}
	}

	function finishBoot() {
		if (finishing || !boot) {
			return;
		}
		finishing = true;
		currentPercent = 100;
		if (bootFill) {
			bootFill.style.width = "100%";
		}
		if (bootProgress) {
			bootProgress.textContent = "Загрузка 100%";
		}
		positionMiner(100);
		boot.classList.add("done");
		window.setTimeout(removeBoot, 1250);
	}

	function removeBoot() {
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
		if (bootDemo || loadingTimer || !frame) {
			return;
		}
		var started = performance.now();
		loadingTimer = window.setInterval(function () {
			try {
				var doc = frame.contentDocument;
				// about:blank до начала загрузки: канваса ещё нет.
				if (!doc || !doc.getElementById("canvas")) {
					if (performance.now() - started > 30000) {
						removeBoot();
					}
					return;
				}
				styleGameDocument();
				if (!doc.getElementById("status")) {
					finishBoot(); // Godot убрал свой экран — игра пошла
					return;
				}
				var notice = doc.getElementById("status-notice");
				if (notice && notice.style.display !== "none" && notice.textContent.trim()) {
					removeBoot(); // показываем ошибку движка
					return;
				}
				var progress = doc.getElementById("status-progress");
				if (progress && progress.max > 0) {
					var percent = Math.round((progress.value / progress.max) * 100);
					if (isFinite(percent)) {
						setProgress(Math.max(0, Math.min(100, percent)));
					}
				}
			} catch (error) {
				/* другой origin — просто ждём загрузки */
			}
			if (performance.now() - started > 300000) {
				removeBoot(); // страховка: 5 минут — уже слишком долго
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

	/*
	 * Web Push для игры (03.11).
	 *
	 * Игра в iframe зовёт window.parent.__darkLodePush.state/subscribe/
	 * unsubscribe; промис из Godot не вернуть, поэтому ответы приходят сюда же
	 * как обычные объекты. Подписку браузера (endpoint + ключи) игра отдаёт
	 * своему серверу по WebSocket — сама оболочка на бэкенд не ходит.
	 *
	 * В Telegram Mini App системных push нет: там уведомления шлёт бот, поэтому
	 * мост честно отвечает telegram и ничего не спрашивает у браузера. На
	 * http-адресе Push API недоступен; в остальных случаях показываем причину,
	 * а не молчаливый отказ.
	 */
	var PUSH_SCOPE = "sw.js";
	var PUSH_PERMISSION_WAIT = 20000;
	var PUSH_READY_WAIT = 15000;

	function inTelegram() {
		return !!(tg && (tg.initData || (tg.platform && tg.platform !== "unknown")));
	}

	function pushState() {
		if (inTelegram()) {
			return { available: false, reason: "telegram", permission: "" };
		}
		if (!window.isSecureContext) {
			return { available: false, reason: "insecure", permission: "" };
		}
		if (!("serviceWorker" in navigator) || !("PushManager" in window) ||
				typeof window.Notification !== "function") {
			return { available: false, reason: "unsupported", permission: "" };
		}
		return {
			available: true,
			reason: "ready",
			permission: String(window.Notification.permission || "default"),
		};
	}

	function pushFail(code) {
		return { ok: false, error: String(code || "unsupported") };
	}

	function pushCode(error) {
		if (error && error.ok === false && error.error) {
			return String(error.error);
		}
		var name = error && error.name ? String(error.name) : "";
		if (name === "NotAllowedError" || name === "PermissionDeniedError" ||
				name === "InvalidStateError") {
			return "denied";
		}
		if (name === "NotSupportedError") {
			return "unsupported";
		}
		if (name === "SecurityError") {
			return "insecure";
		}
		if (name === "AbortError") {
			return "timeout";
		}
		return "unsupported";
	}

	function pushWithTimeout(promise, milliseconds, code) {
		return new Promise(function (resolve, reject) {
			var timer = window.setTimeout(function () {
				reject(pushFail(code || "timeout"));
			}, milliseconds);
			promise.then(function (value) {
				window.clearTimeout(timer);
				resolve(value);
			}, function (error) {
				window.clearTimeout(timer);
				reject(error);
			});
		});
	}

	function urlBase64Bytes(value) {
		var text = String(value || "").trim().replace(/-/g, "+").replace(/_/g, "/");
		while (text.length % 4) {
			text += "=";
		}
		var binary = window.atob(text);
		var bytes = new Uint8Array(binary.length);
		for (var i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}
		return bytes;
	}

	function bytesBase64Url(buffer) {
		if (!buffer) {
			return "";
		}
		var bytes = new Uint8Array(buffer);
		var binary = "";
		for (var i = 0; i < bytes.length; i++) {
			binary += String.fromCharCode(bytes[i]);
		}
		return window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	}

	function pushSubscriptionJson(subscription) {
		var endpoint = String((subscription && subscription.endpoint) || "");
		var keys = {};
		try {
			var json = subscription.toJSON ? subscription.toJSON() : null;
			if (json && json.keys) {
				keys = json.keys;
			}
		} catch (error) {
			/* toJSON есть не везде — соберём ключи вручную */
		}
		if ((!keys || !keys.p256dh || !keys.auth) && subscription.getKey) {
			keys = {
				p256dh: bytesBase64Url(subscription.getKey("p256dh")),
				auth: bytesBase64Url(subscription.getKey("auth")),
			};
		}
		return {
			ok: true,
			endpoint: endpoint,
			keys: {
				p256dh: String((keys && keys.p256dh) || ""),
				auth: String((keys && keys.auth) || ""),
			},
			user_agent: String(navigator.userAgent || ""),
			permission: String(window.Notification.permission || ""),
		};
	}

	function pushRegistration() {
		if (!("serviceWorker" in navigator)) {
			return Promise.reject(pushFail("unsupported"));
		}
		var registered;
		try {
			registered = navigator.serviceWorker.register(PUSH_SCOPE);
		} catch (error) {
			return Promise.reject(pushFail("no_service_worker"));
		}
		return pushWithTimeout(registered, PUSH_READY_WAIT, "no_service_worker")
			.then(function () {
				return pushWithTimeout(navigator.serviceWorker.ready,
					PUSH_READY_WAIT, "no_service_worker");
			});
	}

	function pushSubscribe(vapidKey) {
		var state = pushState();
		if (!state.available) {
			return Promise.resolve(pushFail(state.reason || "unsupported"));
		}
		if (!vapidKey) {
			return Promise.resolve(pushFail("missing"));
		}
		var permission = String(window.Notification.permission || "default");
		if (permission === "denied") {
			return Promise.resolve(pushFail("denied"));
		}
		// Спрашиваем разрешение сразу, пока клик ещё считается жестом
		// пользователя: после регистрации воркера браузер может его не зачесть.
		var asked;
		if (permission === "granted") {
			asked = Promise.resolve(permission);
		} else {
			try {
				asked = Promise.resolve(window.Notification.requestPermission());
			} catch (error) {
				asked = Promise.reject(pushFail("denied"));
			}
		}
		return pushRegistration().then(function (registration) {
			return pushWithTimeout(asked, PUSH_PERMISSION_WAIT, "timeout")
				.then(function (result) {
					if (String(result) !== "granted") {
						return pushFail("denied");
					}
					var applicationServerKey;
					try {
						applicationServerKey = urlBase64Bytes(vapidKey);
					} catch (error) {
						return pushFail("bad_key");
					}
					if (!applicationServerKey || applicationServerKey.length < 32) {
						return pushFail("bad_key");
					}
					return registration.pushManager.getSubscription().then(function (existing) {
						if (existing) {
							// Этот браузер уже подписан: сервер обновит строку по
							// endpoint, повторная подписка не нужна.
							return pushSubscriptionJson(existing);
						}
						return registration.pushManager.subscribe({
							userVisibleOnly: true,
							applicationServerKey: applicationServerKey,
						}).then(pushSubscriptionJson);
					});
				});
		}).catch(function (error) {
			return pushFail(pushCode(error));
		});
	}

	function pushUnsubscribe() {
		var state = pushState();
		if (!state.available) {
			// В Telegram и старых браузерах подписки нет — для игры это успех:
			// отписка лишь убирает возможную строку на сервере.
			return Promise.resolve({ ok: true, endpoint: "" });
		}
		return pushRegistration().then(function (registration) {
			return registration.pushManager.getSubscription();
		}).then(function (subscription) {
			if (!subscription) {
				return { ok: true, endpoint: "" };
			}
			var endpoint = String(subscription.endpoint || "");
			return subscription.unsubscribe().then(function () {
				return { ok: true, endpoint: endpoint };
			});
		}).catch(function (error) {
			return pushFail(pushCode(error));
		});
	}

	function registerPushWorker() {
		if (inTelegram() || !pushState().available) {
			return;
		}
		try {
			navigator.serviceWorker.register(PUSH_SCOPE).catch(function () {
				/* без воркера push просто недоступен — загрузку не ломаем */
			});
		} catch (error) {
			/* то же */
		}
	}

	window.__darkLodePush = {
		state: pushState,
		subscribe: pushSubscribe,
		unsubscribe: pushUnsubscribe,
	};

	registerPushWorker();
	configureTelegram();
	positionMiner(0);
	window.addEventListener("resize", function () {
		positionMiner(currentPercent);
	});
	// Небольшой отладочный хук: удобно проверить заставку локально.
	window.__darkLodeBoot = {
		progress: setProgress,
		finish: finishBoot,
		remove: removeBoot,
	};

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
