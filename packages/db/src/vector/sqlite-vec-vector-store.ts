import type {
  ArticleVectorInput,
  DibaoDatabase,
  EmbeddingIndexRow,
  SimilarArticleQuery,
  VectorSearchResult
} from "../types.js";
import { toVectorBlob, toVectorMatchValue } from "./serialization.js";

export interface VectorStore {
  ensureIndex(embeddingIndexId: string): void;
  upsertArticleVector(input: ArticleVectorInput): void;
  deleteArticleVector(articleId: string, embeddingIndexId: string): void;
  deleteArticleVectors(articleId: string): number;
  searchSimilarArticles(input: SimilarArticleQuery): VectorSearchResult[];
  rebuildIndex(embeddingIndexId: string): void;
}

export class SqliteVecVectorStore implements VectorStore {
  constructor(private readonly db: DibaoDatabase) {}

  ensureIndex(embeddingIndexId: string): void {
    const index = this.getEmbeddingIndex(embeddingIndexId);
    this.createVecTable(index);
  }

  upsertArticleVector(input: ArticleVectorInput): void {
    const index = this.getEmbeddingIndex(input.embeddingIndexId);
    const vectorBlob = toVectorBlob(input.vector);
    const now = input.now ?? Date.now();

    this.validateVectorDimension(vectorBlob, index);

    this.db.transaction(() => {
      this.createVecTable(index);
      this.deleteArticleVector(input.articleId, input.embeddingIndexId);

      this.db
        .prepare(
          `
            insert into article_embeddings (
              article_id,
              embedding_index_id,
              vector_blob,
              content_hash,
              created_at,
              updated_at
            )
            values (?, ?, ?, ?, ?, ?)
            on conflict(article_id, embedding_index_id) do update set
              vector_blob = excluded.vector_blob,
              content_hash = excluded.content_hash,
              updated_at = excluded.updated_at
          `
        )
        .run(
          input.articleId,
          input.embeddingIndexId,
          vectorBlob,
          input.contentHash,
          now,
          now
        );

      const insertResult = this.db
        .prepare(
          `
            insert into ${quoteIdentifier(index.tableName)} (embedding)
            values (?)
          `
        )
        .run(vectorBlob);

      this.db
        .prepare(
          `
            insert into article_vector_rows (
              article_id,
              embedding_index_id,
              vec_rowid,
              created_at
            )
            values (?, ?, ?, ?)
          `
        )
        .run(
          input.articleId,
          input.embeddingIndexId,
          Number(insertResult.lastInsertRowid),
          now
        );
    })();
  }

  deleteArticleVector(articleId: string, embeddingIndexId: string): void {
    const index = this.getEmbeddingIndex(embeddingIndexId);
    const existing = this.db
      .prepare(
        `
          select vec_rowid as vecRowid
          from article_vector_rows
          where article_id = ? and embedding_index_id = ?
        `
      )
      .get(articleId, embeddingIndexId) as { vecRowid: number } | undefined;

    if (!existing) {
      this.db
        .prepare(
          `
            delete from article_embeddings
            where article_id = ? and embedding_index_id = ?
          `
        )
        .run(articleId, embeddingIndexId);
      return;
    }

    this.db.transaction(() => {
      this.createVecTable(index);
      this.db
        .prepare(
          `
            delete from ${quoteIdentifier(index.tableName)}
            where rowid = ?
          `
        )
        .run(existing.vecRowid);
      this.db
        .prepare(
          `
            delete from article_vector_rows
            where article_id = ? and embedding_index_id = ?
          `
        )
        .run(articleId, embeddingIndexId);
      this.db
        .prepare(
          `
            delete from article_embeddings
            where article_id = ? and embedding_index_id = ?
          `
        )
        .run(articleId, embeddingIndexId);
    })();
  }

  deleteArticleVectors(articleId: string): number {
    const rows = this.db
      .prepare(
        `
          select
            avr.embedding_index_id as embeddingIndexId,
            avr.vec_rowid as vecRowid,
            ei.id,
            ei.provider_id as providerId,
            ei.model,
            ei.dimension,
            ei.text_max_chars as textMaxChars,
            ei.distance_metric as distanceMetric,
            ei.table_name as tableName,
            ei.status
          from article_vector_rows avr
          join embedding_indexes ei on ei.id = avr.embedding_index_id
          where avr.article_id = ?
        `
      )
      .all(articleId) as Array<EmbeddingIndexRow & { vecRowid: number }>;

    return this.db.transaction(() => {
      for (const row of rows) {
        this.createVecTable(row);
        this.db
          .prepare(
            `
              delete from ${quoteIdentifier(row.tableName)}
              where rowid = ?
            `
          )
          .run(row.vecRowid);
      }

      this.db
        .prepare("delete from article_vector_rows where article_id = ?")
        .run(articleId);
      const deletedEmbeddings = this.db
        .prepare("delete from article_embeddings where article_id = ?")
        .run(articleId);

      return deletedEmbeddings.changes;
    })();
  }

  searchSimilarArticles(input: SimilarArticleQuery): VectorSearchResult[] {
    const index = this.getEmbeddingIndex(input.embeddingIndexId);
    const limit = input.limit ?? 20;

    this.createVecTable(index);

    return this.db
      .prepare(
        `
          select
            avr.article_id as articleId,
            v.distance as distance
          from ${quoteIdentifier(index.tableName)} v
          join article_vector_rows avr
            on avr.vec_rowid = v.rowid
           and avr.embedding_index_id = ?
          where v.embedding match ?
            and k = ?
          order by v.distance
        `
      )
      .all(input.embeddingIndexId, toVectorMatchValue(input.vector), limit) as VectorSearchResult[];
  }

  rebuildIndex(embeddingIndexId: string): void {
    const index = this.getEmbeddingIndex(embeddingIndexId);
    const now = Date.now();
    const rows = this.db
      .prepare(
        `
          select article_id as articleId, vector_blob as vectorBlob
          from article_embeddings
          where embedding_index_id = ?
          order by article_id
        `
      )
      .all(embeddingIndexId) as Array<{ articleId: string; vectorBlob: Buffer }>;

    this.db.transaction(() => {
      this.createVecTable(index);
      this.db.exec(`delete from ${quoteIdentifier(index.tableName)}`);
      this.db
        .prepare("delete from article_vector_rows where embedding_index_id = ?")
        .run(embeddingIndexId);

      const insertVec = this.db.prepare(
        `
          insert into ${quoteIdentifier(index.tableName)} (embedding)
          values (?)
        `
      );
      const insertRow = this.db.prepare(
        `
          insert into article_vector_rows (
            article_id,
            embedding_index_id,
            vec_rowid,
            created_at
          )
          values (?, ?, ?, ?)
        `
      );

      for (const row of rows) {
        this.validateVectorDimension(row.vectorBlob, index);
        const result = insertVec.run(row.vectorBlob);
        insertRow.run(
          row.articleId,
          embeddingIndexId,
          Number(result.lastInsertRowid),
          now
        );
      }
    })();
  }

  private getEmbeddingIndex(embeddingIndexId: string): EmbeddingIndexRow {
    const index = this.db
      .prepare(
        `
          select
            id,
            provider_id as providerId,
            model,
            dimension,
            text_max_chars as textMaxChars,
            distance_metric as distanceMetric,
            table_name as tableName,
            status
          from embedding_indexes
          where id = ?
        `
      )
      .get(embeddingIndexId) as EmbeddingIndexRow | undefined;

    if (!index) {
      throw new Error(`Embedding index not found: ${embeddingIndexId}`);
    }

    if (index.distanceMetric !== "cosine") {
      throw new Error(`Unsupported vector distance metric: ${index.distanceMetric}`);
    }

    return index;
  }

  private createVecTable(index: EmbeddingIndexRow): void {
    assertSafeVecTableName(index.tableName);
    const existing = this.db
      .prepare("select sql from sqlite_master where type = 'table' and name = ?")
      .get(index.tableName) as { sql: string | null } | undefined;

    if (existing) {
      if (isCosineVecTableSql(existing.sql)) {
        return;
      }
      this.recreateVecTableWithCosine(index);
      return;
    }

    this.db.exec(
      `
        create virtual table if not exists ${quoteIdentifier(index.tableName)}
        using vec0(embedding float[${index.dimension}] distance_metric=cosine)
      `
    );
  }

  private recreateVecTableWithCosine(index: EmbeddingIndexRow): void {
    const rows = this.db
      .prepare(
        `
          select article_id as articleId, vector_blob as vectorBlob
          from article_embeddings
          where embedding_index_id = ?
          order by article_id
        `
      )
      .all(index.id) as Array<{ articleId: string; vectorBlob: Buffer }>;
    const now = Date.now();

    this.db.transaction(() => {
      this.db.exec(`drop table if exists ${quoteIdentifier(index.tableName)}`);
      this.db
        .prepare("delete from article_vector_rows where embedding_index_id = ?")
        .run(index.id);
      this.db.exec(
        `
          create virtual table ${quoteIdentifier(index.tableName)}
          using vec0(embedding float[${index.dimension}] distance_metric=cosine)
        `
      );

      const insertVec = this.db.prepare(
        `
          insert into ${quoteIdentifier(index.tableName)} (embedding)
          values (?)
        `
      );
      const insertRow = this.db.prepare(
        `
          insert into article_vector_rows (
            article_id,
            embedding_index_id,
            vec_rowid,
            created_at
          )
          values (?, ?, ?, ?)
        `
      );

      for (const row of rows) {
        this.validateVectorDimension(row.vectorBlob, index);
        const result = insertVec.run(row.vectorBlob);
        insertRow.run(row.articleId, index.id, Number(result.lastInsertRowid), now);
      }
    })();
  }

  private validateVectorDimension(vectorBlob: Buffer, index: EmbeddingIndexRow): void {
    const bytesPerFloat32 = 4;
    const actualDimension = vectorBlob.byteLength / bytesPerFloat32;

    if (!Number.isInteger(actualDimension) || actualDimension !== index.dimension) {
      throw new Error(
        `Vector dimension mismatch for ${index.id}: expected ${index.dimension}, got ${actualDimension}`
      );
    }
  }
}

export function safeVecTableName(embeddingIndexId: string): string {
  return `vec_articles_${embeddingIndexId.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}

function assertSafeVecTableName(tableName: string): void {
  if (!/^vec_articles_[a-zA-Z0-9_]+$/.test(tableName)) {
    throw new Error(`Unsafe sqlite-vec table name: ${tableName}`);
  }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function isCosineVecTableSql(sql: string | null): boolean {
  return /\bdistance_metric\s*=\s*cosine\b/i.test(sql ?? "");
}
