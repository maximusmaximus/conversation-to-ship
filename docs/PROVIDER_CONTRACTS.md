# Swappable Provider Contracts & Canonical Domain Events

Every external tool used in the workflow is isolated behind typed interfaces so software choices (Calendly, Google Calendar, Google Meet, Read.ai, GitHub, Cloudflare) can be swapped via configuration or the Studio UI without altering core orchestration logic.

---

## 1. Canonical Domain Events

All adapters emit normalized immutable events into the platform's event log and Cloudflare Queue pipeline:

```typescript
export type DomainEvent =
  | BookingScheduledEvent
  | CalendarEventSyncedEvent
  | MeetingRosterCapturedEvent
  | TranscriptReadyEvent
  | RepoProvisionedEvent
  | CollaboratorInvitedEvent
  | DeploymentPublishedEvent;

export interface CorrelationHints {
  meetUrlCode?: string;     // Normalized e.g. "meet:abc-defg-hij"
  calendarIcalUid?: string; // RFC 5545 UID or provider eventId
  bookingUri?: string;      // e.g. Calendly event URI
  startTimeIso: string;     // UTC ISO-8601
  participantEmails: string[];
}

export interface BookingScheduledEvent {
  type: "BookingScheduled";
  provider: string;         // "calendly" | "generic_webhook"
  externalId: string;
  correlation: CorrelationHints;
  objective: string | null;
  tags: string[];
  productArea: string | null;
  constraints: string[];
  decisionNeeded: string | null;
  invitees: Array<{ name: string; email: string; role: "booker" | "guest" }>;
}

export interface CalendarEventSyncedEvent {
  type: "CalendarEventSynced";
  provider: string;         // "google_calendar" | "generic_ics" | "outlook_stub"
  externalId: string;
  correlation: CorrelationHints;
  title: string;
  endTimeIso: string;
  organizerEmail: string | null;
  attendees: Array<{ name?: string; email: string; responseStatus?: string }>;
  meetingLink: string | null;
}

export interface MeetingRosterCapturedEvent {
  type: "MeetingRosterCaptured";
  provider: string;         // "google_meet" | "read_ai" | "oauth_claim"
  meetingSessionId: string;
  participants: Array<{
    displayName: string;
    email?: string;
    githubUsername?: string;
    joinedAtIso?: string;
    leftAtIso?: string;
    source: "calendar" | "meet_api" | "read_ai" | "oauth_claim";
  }>;
}

export interface TranscriptReadyEvent {
  type: "TranscriptReady";
  provider: string;         // "read_ai" | "google_meet_drive" | "manual_upload"
  externalId: string;
  correlation: CorrelationHints;
  title: string;
  rawObjectKey: string;     // Cloudflare R2 key
  utterances: Array<{
    utteranceId: string;
    speaker: string;
    speakerEmail?: string;
    startMs?: number;
    endMs?: number;
    text: string;
  }>;
}
```

---

## 2. Adapter Interfaces (TypeScript Reference Contracts)

```typescript
export interface ProviderHealth {
  ok: boolean;
  provider: string;
  mode: "webhook" | "polling" | "mcp" | "manual";
  message: string;
}

export interface BookingProvider {
  readonly id: string;
  healthCheck(): Promise<ProviderHealth>;
  verifyWebhook(headers: Headers, rawBody: string): Promise<boolean>;
  parseWebhook(payload: unknown): Promise<BookingScheduledEvent>;
}

export interface CalendarProvider {
  readonly id: string;
  healthCheck(): Promise<ProviderHealth>;
  verifyPushNotification(headers: Headers): Promise<boolean>;
  syncEvents(cursor?: string): Promise<{ events: CalendarEventSyncedEvent[]; nextCursor?: string }>;
  parseIcsFallback?(icsContent: string): Promise<CalendarEventSyncedEvent[]>;
}

export interface MeetingProvider {
  readonly id: string;
  readonly supportsLiveParticipantsApi: boolean;
  healthCheck(): Promise<ProviderHealth>;
  extractMeetingCode(url: string): string | null;
  fetchParticipants(conferenceRef: string): Promise<MeetingRosterCapturedEvent>;
}

export interface TranscriptProvider {
  readonly id: string;
  healthCheck(): Promise<ProviderHealth>;
  verifyWebhook(headers: Headers, rawBody: string): Promise<boolean>;
  ingestWebhook(payload: unknown): Promise<TranscriptReadyEvent>;
  fetchBySessionId?(sessionId: string): Promise<TranscriptReadyEvent>;
  parseUpload?(filename: string, content: string): Promise<TranscriptReadyEvent>;
}

export interface RepoProvider {
  readonly id: string;
  createRepo(input: { owner: string; name: string; private: boolean; description: string }): Promise<{ repoUrl: string; fullName: string }>;
  inviteCollaborator(input: { fullName: string; githubUsername?: string; email?: string; permission: "pull" | "triage" | "push" | "maintain" }): Promise<{ status: "invited" | "already_member" | "pending_claim" }>;
  openPullRequest(input: { fullName: string; branch: string; base: string; title: string; body: string }): Promise<{ prUrl: string; prNumber: number }>;
}

export interface DeployProvider {
  readonly id: string;
  deployPreview(input: { projectId: string; repoPath: string; branch: string; r2Prefix: string }): Promise<{ previewUrl: string; deploymentId: string }>;
  promoteProduction(input: { projectId: string; deploymentId: string; customDomain?: string }): Promise<{ productionUrl: string }>;
}
```

---

## 3. Day-1 Adapter Coverage Matrix

| Provider ID | Category | Transport / Source | Capability Notes |
| --- | --- | --- | --- |
| `calendly` | Booking | `invitee.created` HMAC webhook + PAT REST | Extracts objective, tags, UTM campaign, product area, constraints. |
| `generic_webhook` | Booking | Built-in portal booking endpoint / Cal.com JSON | Drop-in replacement when Calendly is swapped out. |
| `google_calendar` | Calendar | Watch channel push + Calendar API v3 | Extracts `iCalUID`, `hangoutLink`/`conferenceData`, invitee emails. |
| `generic_ics` | Calendar | Uploaded `.ics` or subscribed ICS URL | Parses RFC 5545 `VEVENT`, `UID`, `ATTENDEE`, `LOCATION` URLs. |
| `outlook_stub` | Calendar | Microsoft Graph contract stub | Ready for Graph `/subscriptions` webhook implementation. |
| `google_meet` | Meeting | Meet REST `conferenceRecords` + `participants` | Resolves actual call joiners beyond original calendar invitees. |
| `generic_link` | Meeting | Any conference URL + Claim OAuth check-in | Supports Zoom/Jitsi/custom calls via 1-click Claim Link roster. |
| `read_ai` | Transcript | `meeting_end` webhook + Read MCP / REST API | Always treats raw transcript utterances as source of truth over auto-summary. |
| `google_meet_drive` | Transcript | Google Drive API Meet transcript Docs export | Parses Meet native speaker-timestamped Google Doc transcripts. |
| `manual_upload` | Transcript | Portal upload (`.vtt`, `.srt`, `.txt`, `.json`) | Guaranteed fallback regardless of third-party transcript vendor. |
| `github` | Repo | GitHub App / OAuth + REST API | Private by default, never pushes to `main`, never requests `delete_repo`. |
| `cloudflare` | Deploy | Cloudflare Workers / Pages + Wrangler + R2 | Deploys isolated previews, binds R2 buckets, promotes production URLs. |
