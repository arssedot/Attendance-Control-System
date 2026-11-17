# REST API Attendance v1

Префикс `/api/v1`. Тело запроса и ответа в JSON. Все даты в ISO 8601, часы в UTC. Идентификаторы ресурсов являются UUID. Авторизация `Authorization: Bearer <access_token>`. Ошибки имеют поля `code`, `message`, `request_id`. Запросы списков принимают `limit` (1–100) и `offset` (0–10000).

| Метод и путь | Доступ | Запрос | Результат |
| --- | --- | --- | --- |
| POST /auth/login | Все | `login`, `password`, `client` (web или mobile) | `user`, `access_token`, `expires_in`, refresh в cookie или `refresh_token` |
| POST /auth/refresh | Refresh JWT | `refresh_token` для mobile, пустой объект для web | Новая пара JWT по правилам выбранного клиента |
| POST /auth/logout | Refresh JWT | Тот же формат, что для refresh | 204, отзыв сессии входа |
| GET /schedule | Обе роли | `date` (день по Москве, по умолчанию сегодня), пагинация | Занятия роли с идентификатором и состоянием сессии |
| POST /sessions | Преподаватель | `schedule_id`, `ttl_minutes`, `late_after_minutes` | 201 при создании, текущая сессия при повторе |
| GET /sessions/{id} | Владелец | — | Сессия с `qr_image` в PNG data URI, когда регистрация открыта |
| PATCH /sessions/{id} | Владелец | `ttl_minutes` и/или `late_after_minutes`, либо `close: true` | Обновлённая сессия |
| GET /sessions/{id}/attendance | Владелец | Пагинация | Отметки с именами, идентификаторами студентов и признаком `has_location` |
| GET /sessions/{id}/attendance/{student_id}/location | Владелец | — | Координаты, погрешность в метрах и название корпуса. 404, если точка отсутствует |
| POST /attendance/qr | Студент | `token` | Отметка с временем, способом и статусом |
| POST /attendance/geo | Студент | `schedule_id`, `latitude`, `longitude`, `horizontal_accuracy` (м) | Отметка с временем, способом и статусом |
| GET /student/attendance | Студент | Пагинация | Личная история с названиями занятий |

401 означает, что нужна действующая авторизация, 403 означает запрет для роли, 404 для отсутствующего или недоступного ресурса, 409 для неподходящего состояния, 422 для недопустимых данных, QR или геопозиции. 429 возвращает `Retry-After` для ограниченных запросов. Swagger UI доступен по `/docs`, машиночитаемый контракт по `/openapi.json`.
