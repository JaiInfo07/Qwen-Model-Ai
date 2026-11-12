# Office AI Chat — v6.4 AirLLM Provider Integration

A local Node.js chat interface with a rollback-safe AI provider switch. Normal
text chats can use the Devstral Small 2505 model through the AirLLM FastAPI
service, while the original Ollama path remains available for rollback,
embeddings, and optional image analysis.


## AI provider switch

Set the active text-generation provider in `.env`:

```text
AI_PROVIDER=airllm
```

The AirLLM settings are:

```text
AIRLLM_URL=http://localhost:8001
AIRLLM_API_KEY=devstral-local-secret
AIRLLM_MODEL_LABEL=Devstral-Small-2505-AirLLM
AIRLLM_MAX_NEW_TOKENS=1
AIRLLM_TEMPERATURE=0
AIRLLM_VISION_FALLBACK=ollama
```

Start the tested WSL AirLLM API before starting Node.js:

```bash
cd ~/airLLM
source .venv/bin/activate
export HF_HOME="$HOME/airLLM/storage/hf-cache"
uvicorn airllm_api:app --host 0.0.0.0 --port 8001 --workers 1
```

To immediately return normal text chats to the previous model, set:

```text
AI_PROVIDER=ollama
```

See `AIRLLM-INTEGRATION.md` for verification steps, health checks, image
fallback behavior, and current CPU-only limitations.

## New authentication features

- Email syntax and domain validation on both the browser and server
- Username validation: 3–24 characters, begins with a letter, and supports only
  letters, numbers, dots, and underscores
- Live duplicate email and username checks
- Password strength indicator and server-side strength enforcement
- Password hashing with `bcryptjs` before anything is stored
- Six-digit cryptographically generated email OTP
- Five-minute OTP expiry
- Resend button with a 60-second cooldown
- Maximum five incorrect OTP attempts
- Maximum five resends for one sign-up flow
- Case-insensitive email and username duplicate protection
- Professional responsive HTML verification email with a text fallback
- Session regeneration after login or successful verification

New accounts are created only after the OTP is verified. Existing accounts from
older versions, which may not contain an email field, can still log in with their
existing username and password.

## Sign-up flow

1. The user enters email, username, and password.
2. The browser validates the fields and checks duplicates.
3. The server repeats every validation and hashes the password.
4. A six-digit OTP is generated, hashed, and stored as a pending sign-up.
5. The verification email is sent.
6. The user has five minutes and five attempts to verify the code.
7. After successful verification, the final user record is created and the user
   is logged in.

The raw password and raw OTP are never written to `db.json`.

## SMTP setup

Copy `.env.example` to `.env` and replace the SMTP values with credentials from
your email provider:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Minimum email configuration:

```text
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=no-reply@example.com
SMTP_PASS=your-smtp-password
EMAIL_FROM_NAME=Office AI Chat
EMAIL_FROM_ADDRESS=no-reply@example.com
```

For port `465`, set `SMTP_SECURE=true`. For port `587`, normally use
`SMTP_SECURE=false` so the connection can upgrade with STARTTLS.

### Local development without SMTP

When `NODE_ENV` is not `production` and SMTP is not configured, the verification
code is printed in the Node.js terminal. The UI clearly identifies this as local
development mode. In production, sign-up fails safely when SMTP is missing.

## Password policy

A new password must:

- contain at least 8 characters
- contain uppercase and lowercase letters
- contain a number
- contain a special character
- contain no spaces
- not contain the username or the email name
- remain within bcrypt's 72-byte input limit

The default bcrypt work factor is 12 and can be changed through
`BCRYPT_ROUNDS` between 10 and 14.

## Existing AI chat features

- Working paperclip attachment picker with removable file chips
- Drag-and-drop attachments
- TXT/code, PDF, DOCX, XLSX, PNG, JPG/JPEG, and WEBP support
- Text extraction for documents and automatic image routing to
  `qwen2.5vl:3b`
- Streamed and stoppable Ollama responses
- Buffered Devstral responses through the AirLLM FastAPI service
- `.env` provider switch with no frontend or database migration
- Ollama vision fallback for images while Devstral handles normal text chats
- Styled Markdown headings, bullets, tables, quotes, links, and code blocks
- Compact sidebar with new-chat icon and clickable avatar settings

## Ollama models used for rollback, embeddings, and image fallback

```bash
ollama pull qwen2.5:3b
ollama pull qwen2.5vl:3b
```

## Install and run

```bash
npm install
npm run check
npm test
npm run test:ai
npm start
```

Open:

```text
http://localhost:3500
```

## Important environment variables

```text
PORT=3500
NODE_ENV=development
SESSION_SECRET=replace-with-a-long-random-secret
OTP_SECRET=replace-with-a-different-long-random-secret
BCRYPT_ROUNDS=12
AI_PROVIDER=airllm
AIRLLM_URL=http://localhost:8001
AIRLLM_API_KEY=devstral-local-secret
AIRLLM_MODEL_LABEL=Devstral-Small-2505-AirLLM
AIRLLM_MAX_NEW_TOKENS=1
AIRLLM_TEMPERATURE=0
AIRLLM_VISION_FALLBACK=ollama
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5:3b
OLLAMA_VISION_MODEL=qwen2.5vl:3b
```

Use strong, different values for `SESSION_SECRET` and `OTP_SECRET` before
production deployment.

## Runtime files

- `db.json` — users, pending sign-ups, conversations, messages, and attachments
- `sessions/` — login and pending-verification sessions
- `uploads/` — uploaded files grouped by user and conversation

These paths and `.env` are excluded by `.gitignore`.

## Quick verification test

1. Start the server with SMTP configured, or use development console mode.
2. Open the sign-up screen.
3. Enter an invalid email and confirm inline validation appears.
4. Enter a valid email and username and confirm availability checks pass.
5. Try a weak password and confirm the checklist blocks submission.
6. Submit valid details and confirm the OTP screen appears.
7. Enter an incorrect code and confirm the remaining attempt count decreases.
8. Use Resend after the countdown and confirm the old code is replaced.
9. Enter the valid code and confirm the account is created and logged in.
10. Log out and sign in again using the username and password.
