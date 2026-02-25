import { describe, test, expect } from "bun:test";
import { isYouTubeUrl, YOUTUBE_HOSTS } from "./constants";

describe("isYouTubeUrl", () => {
  describe("valid YouTube URLs", () => {
    test("youtube.com with watch path", () => {
      expect(isYouTubeUrl("https://youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
        true,
      );
    });

    test("www.youtube.com with watch path", () => {
      expect(isYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
        true,
      );
    });

    test("youtu.be short URL", () => {
      expect(isYouTubeUrl("https://youtu.be/dQw4w9WgXcQ")).toBe(true);
    });

    test("m.youtube.com (mobile)", () => {
      expect(isYouTubeUrl("https://m.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
        true,
      );
    });

    test("music.youtube.com", () => {
      expect(
        isYouTubeUrl("https://music.youtube.com/watch?v=dQw4w9WgXcQ"),
      ).toBe(true);
    });

    test("http (non-https) still works", () => {
      expect(isYouTubeUrl("http://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
        true,
      );
    });

    test("URL with extra query params", () => {
      expect(
        isYouTubeUrl(
          "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf",
        ),
      ).toBe(true);
    });

    test("YouTube playlist URL", () => {
      expect(
        isYouTubeUrl(
          "https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf",
        ),
      ).toBe(true);
    });
  });

  describe("non-YouTube URLs", () => {
    test("Spotify URL", () => {
      expect(isYouTubeUrl("https://open.spotify.com/track/abc123")).toBe(false);
    });

    test("SoundCloud URL", () => {
      expect(isYouTubeUrl("https://soundcloud.com/artist/track")).toBe(false);
    });

    test("random website", () => {
      expect(isYouTubeUrl("https://example.com")).toBe(false);
    });

    test("Jellyfin URL", () => {
      expect(isYouTubeUrl("http://localhost:8096/Items/abc123")).toBe(false);
    });
  });

  describe("non-URL strings", () => {
    test("plain search query", () => {
      expect(isYouTubeUrl("bohemian rhapsody")).toBe(false);
    });

    test("empty string", () => {
      expect(isYouTubeUrl("")).toBe(false);
    });

    test("Jellyfin item ID", () => {
      expect(isYouTubeUrl("abc123def456")).toBe(false);
    });

    test("string containing youtube but not a URL", () => {
      expect(isYouTubeUrl("search youtube for music")).toBe(false);
    });

    test("URL-like but missing protocol", () => {
      expect(isYouTubeUrl("youtube.com/watch?v=abc")).toBe(false);
    });
  });

  describe("YOUTUBE_HOSTS", () => {
    test("contains all expected hosts", () => {
      expect(YOUTUBE_HOSTS).toContain("youtube.com");
      expect(YOUTUBE_HOSTS).toContain("www.youtube.com");
      expect(YOUTUBE_HOSTS).toContain("youtu.be");
      expect(YOUTUBE_HOSTS).toContain("m.youtube.com");
      expect(YOUTUBE_HOSTS).toContain("music.youtube.com");
    });

    test("has exactly 5 entries", () => {
      expect(YOUTUBE_HOSTS).toHaveLength(5);
    });
  });
});
