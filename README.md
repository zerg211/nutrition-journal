# Личный дневник питания (GitHub Pages)

Статическая страница со **сквозным шифрованием записей**. Любой человек может открыть публичную страницу, но не сможет прочитать журнал без личного файла ключа.

## Публикация

1. Создать **публичный** репозиторий `zerg211/nutrition-journal` с веткой `main`.
2. Загрузить в корень репозитория `index.html`, `styles.css`, `app.js`, `journal.json`, `public-key.json`, `.nojekyll`, `README.md`.
3. В `Settings → Pages → Build and deployment` выбрать `Deploy from a branch → main → /(root) → Save`.
4. Открыть `https://zerg211.github.io/nutrition-journal/`.
5. Один раз импортировать выданный отдельно файл `nutrition_journal_private_key.json`. **Никогда не загружать его в репозиторий, комментарии, скриншоты или другие общедоступные места.** Желательно сделать резервную копию в защищённом хранилище. При потере ключа записи восстановить нельзя. Личный ключ из предыдущих неподключённых черновиков недействителен.

## Как вносить записи через чат

После каждого сообщения о еде помощник должен **рассчитать КБЖУ** и добавить зашифрованную запись в `journal.json` коммитом GitHub. Пользователь не вносит данные на сайте. Сайт проверяет новую версию примерно раз в 45 секунд, но GitHub Pages / raw CDN может обновиться с задержкой.

Важно: ChatGPT не получает события автоматически из GitHub. Для записи требуется работающий доступ помощника к GitHub в текущем чате. Не подтверждать запись, пока GitHub не вернул коммит.

### Данные и формат

`public-key.json`: `format`, `keyId`, `publicJwk`. Алгоритм **RSA-OAEP с SHA-256 + AES-256-GCM**.

`journal.json`: `format: "nj-sealed-v1"`, `keyId`, `updatedAt`, `entries: [{v:1,kid,ek,iv,ct}]`.

Каждая запись шифруется отдельно: `ek` — RSA-OAEP(SHA256) от случайного AES-256 ключа (base64url); `iv` — случайные 12 байт (base64url); `ct` — ciphertext+tag AES-256-GCM от компактного JSON объекта (base64url). Каждая запись содержит уникальный непрослеживаемый `id` внутри **зашифрованного** JSON.

Записи:

- Профиль: `{"type":"profile","anchorDate":"YYYY-MM-DD","timezone":"Europe/Moscow","startWeight":80,"goalMin":70,"goalMax":75,"daily":{"kcal":1800,"p":130,"f":60,"c":170}}` (значения вымышленные)
- Еда: `{"type":"meal","id":"uuid","date":"YYYY-MM-DD","time":"HH:MM","name":"...","amount":"...","kcal":300,"p":25,"f":10,"c":30,"estimated":true}`
- Вес: `{"type":"weight","id":"uuid","date":"YYYY-MM-DD","kg":99.4}`

**Важно:** образцы в этом README полностью вымышленные. Настоящие значения профиля есть только внутри зашифрованной записи в `journal.json`.

`anchorDate` — дата начала собственных семидневных периодов, а не ISO-недели. Начало текущего журнала — 01.11.2026 (воскресенье), поэтому первая неделя 1–7 ноября. День определяется в `Europe/Moscow`.

В случае удаления или исправления неверной записи необходимо **прочитать текущий файл GitHub**, создать правильную зашифрованную замену, удалить/заменить нужный envelope и записать новую версию с актуальным SHA. Никогда не оставлять нешифрованный JSON при коммите. При нескольких правках подряд перечитывать файл и не потерять чужие изменения.

### Пример шифрования новой записи на Python

```python
import os, json, base64, uuid
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicNumbers

def b64u(b): return base64.urlsafe_b64encode(b).rstrip(b'=').decode()
def deb64(s): return base64.urlsafe_b64decode(s+'='*(-len(s)%4))
public = json.load(open('public-key.json', encoding='utf-8'))
jwk = public['publicJwk']
key = RSAPublicNumbers(int.from_bytes(deb64(jwk['e']), 'big'), int.from_bytes(deb64(jwk['n']), 'big')).public_key()
meal = {'type':'meal','id':str(uuid.uuid4()),'date':'2026-11-01','time':'13:40','name':'Пример','amount':'200 г','kcal':300,'p':25,'f':10,'c':30,'estimated':True}
aes_key, iv = os.urandom(32), os.urandom(12)
ct = AESGCM(aes_key).encrypt(iv, json.dumps(meal,ensure_ascii=False,separators=(',',':')).encode(), None)
ek = key.encrypt(aes_key, padding.OAEP(mgf=padding.MGF1(hashes.SHA256()),algorithm=hashes.SHA256(),label=None))
envelope={'v':1,'kid':public['keyId'],'ek':b64u(ek),'iv':b64u(iv),'ct':b64u(ct)}
# Добавить envelope в актуальный journal['entries'], обновить updatedAt, обновить journal.json через GitHub с проверкой SHA.
```

## Безопасность

Публичный репозиторий раскрывает число и время коммитов, размеры записей и код сайта, но не содержание еды и вес. Этот механизм защищает конфиденциальность записей от пассивных наблюдателей, но **не** защищает от злоумышленника, который изменит JavaScript самого сайта (например, взломанный GitHub). При использовании на чужом устройстве ключ не импортировать. Для полного сокрытия самого наличия журнала нужен закрытый сервер с аутентификацией.

### Исправления без доступа к закрытому ключу

Можно публиковать дополнительную зашифрованную `meal`-запись с отрицательной или положительной разницей в КБЖУ, назвав её «Корректировка: ...». Пользователь увидит исправление в журнале, а сумма изменится без расшифровки старого набора записей. Не править или удалять неизвестные ciphertext без подтверждения.
