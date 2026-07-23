import { createJellyfinQueueItems } from "@musicd/shared";

import { createApp } from "../app";
import { MockBackend } from "../services/playback/mock-backend";
import { PlayerService } from "../services/player";

import type {
  JellyfinItem,
  PlaybackState,
  QueueItem,
  QueueMode,
} from "@musicd/shared";
import type { ApiJellyfinService, ApiYouTubeService } from "./routes";

interface CliScenario {
  initialQueue: QueueItem[];
  initiallyPlaying: boolean;
  expectedState: PlaybackState;
  expectedCurrentItemId: string | null;
  expectedQueueIds: string[];
  expectedQueuePosition: number;
  initialQueueMode?: QueueMode;
}

const currentTrack: JellyfinItem = {
  Id: "current-id",
  Name: "Current Track",
  Type: "Audio",
  Artists: ["Test Artist"],
  Album: "Test Album",
  RunTimeTicks: 1_800_000_000,
};

const selectedTrack: JellyfinItem = {
  Id: "track-id",
  Name: "Test Track",
  Type: "Audio",
  Artists: ["Test Artist"],
  Album: "Test Album",
  RunTimeTicks: 1_800_000_000,
};

const [currentQueueItem] = createJellyfinQueueItems([currentTrack]);
const youtubeQueueItem: QueueItem = {
  id: "youtube-id",
  name: "YouTube Track",
  artist: "Video Artist",
  duration: 240,
  source: "youtube",
  youtubeUrl: "https://www.youtube.com/watch?v=test-video",
  videoId: "test-video",
  uploader: "Video Artist",
};

const scenarios: Record<string, CliScenario> = {
  "stopped-empty-browse-queue": {
    initialQueue: [],
    initiallyPlaying: false,
    expectedState: "stopped",
    expectedCurrentItemId: null,
    expectedQueueIds: ["track-id"],
    expectedQueuePosition: -1,
  },
  "stopped-existing-queue-add": {
    initialQueue: createJellyfinQueueItems([currentTrack]),
    initiallyPlaying: false,
    expectedState: "stopped",
    expectedCurrentItemId: null,
    expectedQueueIds: ["current-id", "track-id"],
    expectedQueuePosition: -1,
  },
  "playing-existing-browse-queue": {
    initialQueue: createJellyfinQueueItems([currentTrack]),
    initiallyPlaying: true,
    expectedState: "playing",
    expectedCurrentItemId: "current-id",
    expectedQueueIds: ["current-id", "track-id"],
    expectedQueuePosition: 0,
  },
  "playing-existing-browse-play": {
    initialQueue: createJellyfinQueueItems([currentTrack]),
    initiallyPlaying: true,
    expectedState: "playing",
    expectedCurrentItemId: "track-id",
    expectedQueueIds: ["track-id"],
    expectedQueuePosition: 0,
  },
  "loop-enabled-queue-add": {
    initialQueue: createJellyfinQueueItems([currentTrack]),
    initiallyPlaying: false,
    expectedState: "stopped",
    expectedCurrentItemId: null,
    expectedQueueIds: ["current-id", "track-id"],
    expectedQueuePosition: -1,
    initialQueueMode: { loop: true, random: false },
  },
  "queue-interaction": {
    initialQueue: [currentQueueItem, youtubeQueueItem],
    initiallyPlaying: true,
    expectedState: "playing",
    expectedCurrentItemId: "current-id",
    expectedQueueIds: ["current-id", "youtube-id"],
    expectedQueuePosition: 0,
  },
};

function getScenario(name: string | undefined): CliScenario {
  const selectedScenario = name ? scenarios[name] : undefined;
  if (!selectedScenario) {
    throw new Error(`Unknown CLI test scenario: ${name}`);
  }
  return selectedScenario;
}

const scenario = getScenario(process.env.MUSICD_CLI_TEST_SCENARIO);

const itemsById: Record<string, JellyfinItem> = {
  [currentTrack.Id]: currentTrack,
  [selectedTrack.Id]: selectedTrack,
};

function failIfCalled(): never {
  throw new Error("Unexpected fake service call");
}

const jellyfinService: ApiJellyfinService = {
  authenticate: failIfCalled,
  browse: failIfCalled,
  getAlbumTracks: failIfCalled,
  getArtistTracks: failIfCalled,
  getArtwork: failIfCalled,
  getItem: async (id) => {
    const item = itemsById[id];
    if (!item) {
      throw new Error(`Missing test item: ${id}`);
    }
    return item;
  },
  search: async () => [selectedTrack],
};

const youtubeService: ApiYouTubeService = {
  createQueueItem: failIfCalled,
};

const player = new PlayerService(new MockBackend());
player.registerPlaybackSourceResolver("jellyfin", async (item) => ({
  url: `http://test.local/stream/${item.id}`,
}));
player.registerPlaybackSourceResolver("youtube", async (item) => ({
  url: `http://test.local/stream/${item.id}`,
}));
player.addItems(scenario.initialQueue);
if (scenario.initialQueueMode) {
  player.setQueueMode(scenario.initialQueueMode);
}
if (scenario.initiallyPlaying) {
  await player.playFromQueue(0);
}

const app = createApp({
  jellyfinService,
  youtubeService,
  playerService: player,
  startTime: 0,
});

async function getScenarioMismatch(): Promise<string | null> {
  const status = await player.getStatus();
  const queueIds = status.queue.map((item) => item.id);
  const matches =
    status.state === scenario.expectedState &&
    status.currentItem?.id === (scenario.expectedCurrentItemId ?? undefined) &&
    JSON.stringify(queueIds) === JSON.stringify(scenario.expectedQueueIds) &&
    status.queuePosition === scenario.expectedQueuePosition;

  return matches ? null : `Unexpected final state: ${JSON.stringify(status)}`;
}

const originalFetch = globalThis.fetch;
const mockFetch: typeof fetch = Object.assign(
  async function (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const request =
      input instanceof Request
        ? new Request(input, init)
        : new Request(input.toString(), init);
    const requestUrl = new URL(request.url);
    if (
      process.env.MUSICD_CLI_TEST_QUEUE_ERROR === "1" &&
      request.method === "GET" &&
      requestUrl.pathname.endsWith("/api/queue")
    ) {
      return Response.json(
        { success: false, error: "Queue unavailable" },
        { status: 503 },
      );
    }

    const response = await app.fetch(request);

    if (requestUrl.pathname.endsWith("/api/queue/add") && response.ok) {
      const mismatch = await getScenarioMismatch();
      if (mismatch) {
        return Response.json({ error: mismatch }, { status: 500 });
      }
    }

    return response;
  },
  {
    preconnect: originalFetch.preconnect,
  },
);

globalThis.fetch = mockFetch;
