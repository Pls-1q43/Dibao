create table user_representation_snapshots (
  id text primary key check (id = 'current'),
  schema_version integer not null,
  embedding_index_id text references embedding_indexes(id) on delete set null,
  source_watermark integer not null default 0,
  payload_json text not null,
  generated_at integer not null,
  updated_at integer not null
);

create table recommendation_exposures (
  id text primary key,
  client_session_id text not null,
  article_id text not null references articles(id) on delete cascade,
  rank_context text not null,
  rank_position integer,
  feed_id text references feeds(id) on delete set null,
  interest_family_id text,
  duplicate_group_id text,
  was_exploration integer not null default 0 check (was_exploration in (0, 1)),
  exploration_bucket_key text,
  exposed_at integer not null,
  created_at integer not null,
  unique(client_session_id, article_id)
);
create index idx_recommendation_exposures_recent
  on recommendation_exposures(exposed_at desc);
create index idx_recommendation_exposures_article_recent
  on recommendation_exposures(article_id, exposed_at desc);
create index idx_recommendation_exposures_feed_recent
  on recommendation_exposures(feed_id, exposed_at desc);
create index idx_recommendation_exposures_family_recent
  on recommendation_exposures(interest_family_id, exposed_at desc);
create index idx_recommendation_exposures_duplicate_recent
  on recommendation_exposures(duplicate_group_id, exposed_at desc);

create table exploration_attempts (
  exposure_id text primary key references recommendation_exposures(id) on delete cascade,
  bucket_key text not null references exploration_buckets(bucket_key) on delete cascade,
  article_id text not null references articles(id) on delete cascade,
  outcome text not null default 'pending' check (outcome in ('pending', 'neutral', 'weak_failure', 'success', 'strong_success', 'strong_failure')),
  outcome_at integer,
  created_at integer not null,
  updated_at integer not null
);
create index idx_exploration_attempts_bucket_outcome
  on exploration_attempts(bucket_key, outcome, created_at desc);

alter table article_rank_scores add column exploration_bucket_key text;
alter table article_rank_scores add column was_exploration integer not null default 0 check (was_exploration in (0, 1));
