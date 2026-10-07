/**
 * DISABLED on purpose. This route could never succeed:
 *  - it required `embedding.length === 2048`, but getQueryEmbedding() returns
 *    the truncated 1024-dim vector the DB stores;
 *  - it wrote `search_text`/`embedding` into property_features, while the live
 *    schema keeps vectors in property_vectors (halfvec(1024)), populated by the
 *    Python pipeline (see 20261002_align_with_live_schema.sql);
 *  - it embedded documents with input_type "query" (Nemotron is asymmetric:
 *    documents need "passage");
 *  - it was unauthenticated and only guarded by NODE_ENV, which is not a
 *    security boundary on preview deployments (service-role key in scope).
 * Re-embed through the pipeline instead. If you rebuild this, require a secret
 * header and write to property_vectors.
 */
export async function POST() {
  return Response.json(
    { error: "Gone: re-embedding is handled by the Python pipeline (property_vectors)." },
    { status: 410 },
  );
}
