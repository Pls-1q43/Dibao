import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  dibaoPluginBetaApis,
  dibaoPluginStableApis,
  pluginPackageSha256,
  signPluginPackage,
  validatePluginPackage,
  verifyPluginPackageSignature,
  type DibaoPluginPackage
} from "./index.js";

describe("plugin-sdk", () => {
  it("signs and verifies plugin packages with deterministic payloads", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const pluginPackage: DibaoPluginPackage = {
      manifest: {
        manifestVersion: 1,
        id: "com.example.reader-tools",
        name: "Reader Tools",
        version: "1.0.0",
        publisher: "Example",
        dibao: { minVersion: "0.2.0", maxVersion: "<0.3.0" },
        entry: { web: "web/index.html" },
        capabilities: ["settings:plugin"]
      },
      files: {
        "web/index.html": "<!doctype html><html></html>"
      }
    };

    const signed = signPluginPackage({
      pluginPackage,
      privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
      keyId: "example",
      now: () => new Date("2026-06-01T00:00:00Z")
    });

    expect(validatePluginPackage(signed)).toEqual({
      ok: false,
      errors: ["Plugin signature key is not trusted"]
    });
    expect(verifyPluginPackageSignature({ pluginPackage })).toEqual({
      ok: false,
      errors: ["Plugin signature is required"]
    });
    expect(verifyPluginPackageSignature({ pluginPackage: signed })).toEqual({
      ok: false,
      errors: ["Plugin signature key is not trusted"]
    });
    expect(
      verifyPluginPackageSignature({
        pluginPackage: signed,
        trustedPublicKeys: {
          example: publicKey.export({ format: "pem", type: "spki" }).toString()
        }
      })
    ).toEqual({ ok: true });
    expect(pluginPackageSha256(pluginPackage)).toBe(pluginPackageSha256({ ...pluginPackage }));
    expect(
      verifyPluginPackageSignature({
        pluginPackage: {
          ...signed,
          files: {
            ...signed.files,
            "web/index.html": "tampered"
          }
        },
        trustedPublicKeys: {
          example: publicKey.export({ format: "pem", type: "spki" }).toString()
        }
      })
    ).toEqual({ ok: false, errors: ["Plugin signature verification failed"] });
  });

  it("validates migrations and exposes 0.2 API stability constants", () => {
    expect(dibaoPluginStableApis).toContain("database.migrations");
    expect(dibaoPluginBetaApis).toContain("database.defineTable");
    expect(dibaoPluginBetaApis).toContain("fullContent.extractor");

    expect(validatePluginPackage({
      manifest: {
        manifestVersion: 1,
        id: "com.example.migrator",
        name: "Migrator",
        version: "1.0.0",
        publisher: "Example",
        dibao: { minVersion: "0.2.0", maxVersion: "<0.3.0" },
        capabilities: ["database:plugin"],
        migrations: [
          {
            version: "001",
            name: "create_notes",
            path: "migrations/001_create_notes.sql"
          }
        ]
      },
      files: {
        "migrations/001_create_notes.sql": "create table plugin_notes (id integer primary key);"
      }
    })).toEqual({ ok: true });

    expect(validatePluginPackage({
      manifest: {
        manifestVersion: 1,
        id: "com.example.bad-migrator",
        name: "Bad Migrator",
        version: "1.0.0",
        publisher: "Example",
        dibao: { minVersion: "0.2.0", maxVersion: "<0.3.0" },
        capabilities: ["database:plugin"],
        migrations: [
          {
            version: "001",
            name: "create_notes",
            path: "migrations/missing.sql"
          }
        ]
      },
      files: {}
    })).toEqual({
      ok: false,
      errors: ["migration file is missing: migrations/missing.sql"]
    });
  });

  it("validates full content extractor contributions", () => {
    expect(validatePluginPackage({
      manifest: {
        manifestVersion: 1,
        id: "com.example.extractor",
        name: "Extractor",
        version: "1.0.0",
        publisher: "Example",
        dibao: { minVersion: "0.2.0", maxVersion: "<0.3.0" },
        entry: { server: "server/index.mjs" },
        capabilities: [],
        contributes: {
          fullContentExtractors: [
            {
              id: "readable-selectors",
              title: "Readable selectors",
              order: 10
            }
          ]
        }
      },
      files: {
        "server/index.mjs": "export default { activate() {} };"
      }
    })).toEqual({ ok: true });

    expect(validatePluginPackage({
      manifest: {
        manifestVersion: 1,
        id: "com.example.bad-extractor",
        name: "Bad Extractor",
        version: "1.0.0",
        publisher: "Example",
        dibao: { minVersion: "0.2.0", maxVersion: "<0.3.0" },
        entry: { server: "server/index.mjs" },
        capabilities: [],
        contributes: {
          fullContentExtractors: [
            { id: "readable-selectors", title: "Readable selectors" },
            { id: "readable-selectors", title: "Duplicate readable selectors" }
          ]
        }
      },
      files: {}
    })).toEqual({
      ok: false,
      errors: [
        "entry file is missing: server/index.mjs",
        "manifest.contributes.fullContentExtractors contains duplicate id: readable-selectors"
      ]
    });
  });
});
