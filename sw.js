/*
 * Service worker «Тёмной жилы»: только Web Push.
 *
 * Оболочка регистрирует его со своего адреса (GitHub Pages), поэтому область
 * действия — вся папка оболочки вместе с game/. Перехват fetch не делаем:
 * кешем движка и пакета занимается отдельный скрипт в game/index.html, и
 * второй слой кеша только запутал бы обновления.
 *
 * Формат сообщения от бэкенда: {title, body, kind, url, tag}. Текст и адрес
 * клика приходят из backend/node/notify.js; без url открываем корень
 * оболочки.
 */
"use strict";

self.addEventListener("install", function (event) {
	// Новая версия воркера должна заработать сразу, не дожидаясь закрытия
	// всех вкладок: push не должен теряться из-за старого воркера.
	event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", function (event) {
	event.waitUntil(self.clients.claim());
});

function pushPayload(event) {
	if (!event.data) {
		return {};
	}
	try {
		return event.data.json() || {};
	} catch (error) {
		try {
			return { body: event.data.text() };
		} catch (inner) {
			return {};
		}
	}
}

function safeUrl(value) {
	try {
		var url = new URL(String(value || ""), self.registration.scope);
		if (url.protocol !== "https:" && url.protocol !== "http:") {
			return self.registration.scope;
		}
		return url.href;
	} catch (error) {
		return self.registration.scope;
	}
}

self.addEventListener("push", function (event) {
	var payload = pushPayload(event);
	var title = String(payload.title || "Тёмная жила");
	var options = {
		body: String(payload.body || ""),
		icon: String(payload.icon || "game/index.icon.png"),
		badge: String(payload.badge || "game/index.icon.png"),
		tag: String(payload.tag || payload.kind || "darklode"),
		data: { url: safeUrl(payload.url) },
	};
	event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", function (event) {
	event.notification.close();
	var target = self.registration.scope;
	try {
		if (event.notification.data && event.notification.data.url) {
			target = safeUrl(event.notification.data.url);
		}
	} catch (error) {
		/* данные уведомления необязательны */
	}
	event.waitUntil(
		self.clients.matchAll({ type: "window", includeUncontrolled: true })
			.then(function (list) {
				for (var i = 0; i < list.length; i++) {
					// Оболочка и игра — один адрес; свёрнутую вкладку просто
					// поднимаем, новую не плодим.
					if (list[i].url.indexOf(self.registration.scope) === 0) {
						if (typeof list[i].focus === "function") {
							return list[i].focus();
						}
						break;
					}
				}
				if (self.clients.openWindow) {
					return self.clients.openWindow(target);
				}
				return undefined;
			})
			.catch(function () {
				if (self.clients.openWindow) {
					return self.clients.openWindow(target);
				}
				return undefined;
			})
	);
});
