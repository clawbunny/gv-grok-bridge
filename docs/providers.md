# Providers

GV Bridge uses a simple plugin architecture. To add a new voice provider or AI provider, implement the corresponding interface and register it in the provider factory.

## Available Providers

| Type | ID | Description |
|------|-----|-------------|
| Voice | `google-voice` | Google Voice (voice.google.com) |
| Voice | `twilio` | Twilio (stub — not yet implemented) |
| Voice | `textnow` | TextNow (www.textnow.com) — supports cookie import for cross-device auth |
| AI | `grok` | Grok (grok.com) |
| AI | `chatgpt` | ChatGPT (stub — not yet implemented) |

### Cookie Import

Both the **Google Voice** and **TextNow** providers support loading cookies from a JSON file exported from another device. This is useful when you cannot log in directly on the Linux bridge device (e.g., a headless VPS).

#### Google Voice

```yaml
voiceProvider:
  type: google-voice
  config:
    cookiePath: /path/to/gv-cookies.json
```

#### TextNow

```yaml
voiceProvider:
  type: textnow
  config:
    cookiePath: /path/to/textnow-cookies.json
```

The cookie JSON format matches the Chrome cookie export script (`export-cookies.py`). See `docs/authentication.md` for the full export workflow.

## Adding New Providers

## Voice Provider

Implement `VoiceProvider` from `src/providers/contracts.ts`:

```typescript
import type { Page } from 'playwright';
import type { Logger } from '../logger';
import type { CallInfo } from '../types';
import type { VoiceProvider } from '../contracts';

export class MyVoiceProvider implements VoiceProvider {
  readonly id = 'my-voice';
  readonly name = 'My Voice Service';
  readonly url = 'https://voice.example.com';
  readonly origin = 'https://voice.example.com';

  async initialize(page: Page, logger: Logger): Promise<boolean> {
    // Grant mic permissions, navigate, check login
    return true;
  }

  async checkLoggedIn(page: Page, logger: Logger): Promise<boolean> {
    // Return true if user is authenticated
    return true;
  }

  async detectIncomingCall(page: Page, logger: Logger): Promise<CallInfo | null> {
    // Return call info if incoming call is detected, else null
    return null;
  }

  async acceptCall(page: Page, logger: Logger): Promise<void> {
    // Click answer button
  }

  async declineCall(page: Page, logger: Logger): Promise<void> {
    // Click decline/hangup button
  }

  async isCallActive(page: Page, logger: Logger): Promise<boolean> {
    // Return true if a call is in progress
    return false;
  }
}
```

Register in `src/providers/index.ts`:

```typescript
import { MyVoiceProvider } from './voice/my-voice/provider';

const voiceProviders: Map<string, () => VoiceProvider> = new Map([
  // ... existing providers
  ['my-voice', () => new MyVoiceProvider()],
]);
```

## AI Provider

Implement `AIProvider` from `src/providers/contracts.ts`:

```typescript
import type { Page } from 'playwright';
import type { Logger } from '../logger';
import type { AIProvider } from '../contracts';

export class MyAIProvider implements AIProvider {
  readonly id = 'my-ai';
  readonly name = 'My AI';
  readonly url = 'https://ai.example.com';
  readonly origin = 'https://ai.example.com';

  private voiceModeActive = false;

  async initialize(page: Page, logger: Logger): Promise<boolean> {
    return true;
  }

  async checkLoggedIn(page: Page, logger: Logger): Promise<boolean> {
    return true;
  }

  async activateVoiceMode(page: Page, logger: Logger): Promise<boolean> {
    // Click mic button or use keyboard shortcut
    this.voiceModeActive = true;
    return true;
  }

  async deactivateVoiceMode(page: Page, logger: Logger): Promise<boolean> {
    this.voiceModeActive = false;
    return true;
  }

  isVoiceModeActive(): boolean {
    return this.voiceModeActive;
  }
}
```

Register in `src/providers/index.ts`:

```typescript
import { MyAIProvider } from './ai/my-ai/provider';

const aiProviders: Map<string, () => AIProvider> = new Map([
  // ... existing providers
  ['my-ai', () => new MyAIProvider()],
]);
```

## Testing

Add tests in `src/providers/voice/my-voice/__tests__/provider.test.ts` or `src/providers/ai/my-ai/__tests__/provider.test.ts`. Use mocked `Page` objects from Playwright.

## Tips

- Use `page.evaluate()` for DOM queries that need complex logic.
- Use `page.locator(selector).first()` for simple element lookups.
- Always handle exceptions gracefully — the orchestrator will retry on the next poll cycle.
- Log everything via the injected `Logger` for observability.
