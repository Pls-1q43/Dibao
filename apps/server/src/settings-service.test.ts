import { describe, expect, it } from "vitest";
import type { AppSettingsRepository } from "@dibao/db";
import { RETENTION_ARTICLE_DAYS_SETTING_KEY } from "./article-retention-service.js";
import { SettingsService, SettingsServiceError } from "./settings-service.js";

class MemorySettingsRepository implements AppSettingsRepository {
  private readonly values = new Map<string, unknown>();

  getJson<T>(key: string): T | null {
    return this.values.has(key) ? (this.values.get(key) as T) : null;
  }

  setJson(key: string, value: unknown): void {
    this.values.set(key, value);
  }

  delete(key: string): void {
    this.values.delete(key);
  }
}

describe("settings service", () => {
  it("resolves retentionDays from setting, env, then default", () => {
    const settings = new MemorySettingsRepository();
    const service = new SettingsService({
      settings,
      env: {
        DIBAO_ARTICLE_RETENTION_DAYS: "90"
      }
    });

    expect(service.getSettings().retention.retentionDays).toBe(90);

    settings.setJson(RETENTION_ARTICLE_DAYS_SETTING_KEY, 30);
    expect(service.getSettings().retention.retentionDays).toBe(30);

    settings.setJson(RETENTION_ARTICLE_DAYS_SETTING_KEY, 0);
    expect(service.getSettings().retention.retentionDays).toBe(0);

    settings.setJson(RETENTION_ARTICLE_DAYS_SETTING_KEY, "invalid");
    expect(service.getSettings().retention.retentionDays).toBe(0);

    settings.delete(RETENTION_ARTICLE_DAYS_SETTING_KEY);
    const invalidEnvService = new SettingsService({
      settings,
      env: {
        DIBAO_ARTICLE_RETENTION_DAYS: "invalid"
      }
    });
    expect(invalidEnvService.getSettings().retention.retentionDays).toBe(0);
  });

  it("strictly rejects unknown and unwritable settings fields", () => {
    const service = new SettingsService({
      settings: new MemorySettingsRepository()
    });

    for (const payload of [
      {
        ranking: {
          preferFreshness: 0.8
        }
      },
      {
        reader: {
          theme: "paper"
        }
      }
    ]) {
      expect(() => service.updateSettings(payload)).toThrow(SettingsServiceError);
    }
  });

  it("persists default home view and retention policy switches", () => {
    const settings = new MemorySettingsRepository();
    const service = new SettingsService({ settings });

    expect(service.getSettings()).toMatchObject({
      ui: {
        defaultHomeView: "recommended"
      },
      retention: {
        keepFavorites: true,
        keepReadLater: true
      },
      telemetry: {
        enabled: true
      },
      behavior: {
        infiniteArticleLoading: false
      },
      ranking: {
        localLearningEnabled: true,
        localLearningShadowMode: false,
        crossSessionFatigueMode: "shadow",
        recentHistoryMode: "shadow",
        learnedExplorationMode: "shadow"
      }
    });

    expect(
      service.updateSettings({
        ui: {
          defaultHomeView: "latest"
        },
        retention: {
          keepFavorites: false,
          keepReadLater: false
        },
        telemetry: {
          enabled: false
        },
        behavior: {
          infiniteArticleLoading: true
        }
      }).settings
    ).toMatchObject({
      ui: {
        defaultHomeView: "latest"
      },
      retention: {
        keepFavorites: false,
        keepReadLater: false
      },
      telemetry: {
        enabled: false
      },
      behavior: {
        infiniteArticleLoading: true
      }
    });
  });

  it("persists infinite article loading while keeping older behavior settings compatible", () => {
    const settings = new MemorySettingsRepository();
    settings.setJson("behavior.settings", {
      markScrolledArticlesIgnored: false,
      removeReadLaterOnReadComplete: true
    });
    const service = new SettingsService({ settings });

    expect(service.getSettings().behavior).toEqual({
      markScrolledArticlesIgnored: false,
      removeReadLaterOnReadComplete: true,
      infiniteArticleLoading: false
    });

    expect(
      service.updateSettings({ behavior: { infiniteArticleLoading: true } }).settings.behavior
    ).toEqual({
      markScrolledArticlesIgnored: false,
      removeReadLaterOnReadComplete: true,
      infiniteArticleLoading: true
    });

    expect(() =>
      service.updateSettings({ behavior: { infiniteArticleLoading: "yes" } })
    ).toThrow(SettingsServiceError);
  });

  it("persists configurable interest cluster limits and validates bounds", () => {
    const settings = new MemorySettingsRepository();
    const service = new SettingsService({ settings });

    expect(service.getSettings().ranking).toMatchObject({
      maxPositiveInterestClusters: 48,
      maxNegativeInterestClusters: 32,
      maxPositiveInterestFamilies: 16,
      maxNegativeInterestFamilies: 12
    });

    expect(
      service.updateSettings({
        ranking: {
          maxPositiveInterestClusters: 48,
          maxNegativeInterestClusters: 32,
          maxPositiveInterestFamilies: 20,
          maxNegativeInterestFamilies: 10
        }
      }).settings.ranking
    ).toMatchObject({
      maxPositiveInterestClusters: 48,
      maxNegativeInterestClusters: 32,
      maxPositiveInterestFamilies: 20,
      maxNegativeInterestFamilies: 10
    });

    expect(() =>
      service.updateSettings({
        ranking: {
          maxPositiveInterestClusters: 7
        }
      })
    ).toThrow(SettingsServiceError);
    expect(() =>
      service.updateSettings({
        ranking: {
          maxNegativeInterestClusters: 129
        }
      })
    ).toThrow(SettingsServiceError);
    expect(() =>
      service.updateSettings({
        ranking: {
          maxPositiveInterestFamilies: 1
        }
      })
    ).toThrow(SettingsServiceError);
    expect(() =>
      service.updateSettings({
        ranking: {
          maxNegativeInterestFamilies: 49
        }
      })
    ).toThrow(SettingsServiceError);
  });
});
