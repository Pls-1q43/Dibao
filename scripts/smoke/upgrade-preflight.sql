-- Read-only preflight. Set @target_version to the actual image's dibaoVersion
-- (currently package.json version 0.3.1, NOT the development branch name 0.4).
-- sqlite3 -readonly DB -cmd '.parameter set @target_version 0.3.1' < this-file
-- SQL cannot check whether an owner PID is alive; running rows need that check.
with expected as (
  select @target_version as target_version, 'rec_v3' as algorithm_version, 4 as schema_version,
    (select id from embedding_indexes where status='active' order by updated_at desc limit 1) as index_id,
    exists(select 1 from articles where deleted_at is null and status!='deleted') as has_articles
), stored as (
  select (select value_json from app_settings where key='upgrade.derivedData.recommendation-contract') as value
)
select
  e.target_version,
  json_extract(s.value, '$.targetVersion') as stored_version,
  json_extract(s.value, '$.state') as stored_state,
  json_extract(s.value, '$.rankContext') as stored_rank_context,
  e.index_id as active_index,
  json_extract(s.value, '$.owner.host') as owner_host,
  json_extract(s.value, '$.owner.pid') as owner_pid,
  case
    when e.target_version is null then 'ERROR: set @target_version'
    when not e.has_articles then 'no_articles'
    when json_extract(s.value, '$.algorithmVersion') = e.algorithm_version
      and json_extract(s.value, '$.featureSchemaVersion') = e.schema_version
      and json_extract(s.value, '$.state') in ('completed','not_required') then 'no_rebuild'
    when json_extract(s.value, '$.state')='running' then 'wait_for_owner_or_recover_stale_owner'
    else 'blocking_profile_and_full_rank_rebuild_required'
  end as decision,
  (select count(*) from articles where deleted_at is null and status!='deleted') as article_count,
  (select count(*) from article_embeddings) as stored_embedding_count
from expected e cross join stored s;

select version, name from schema_migrations order by version desc limit 3;
select id, status, dimension, table_name from embedding_indexes;
