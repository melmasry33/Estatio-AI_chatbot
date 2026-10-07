import { getSupabase, searchProperties } from "./src/lib/assistant.db.js";
import { getQueryEmbedding } from "./src/lib/assistant.llm.js";
import * as dotenv from "dotenv";
dotenv.config();

async function main() {
  const query = "شقة في التجمع الخامس 3 غرف";
  const embedding = await getQueryEmbedding(query);
  console.log("Got embedding:", embedding?.length);

  // Search with normalized type: شقق
  const results = await searchProperties(embedding, {
    city: "التجمع الخامس",
    property_type: "شقق",
    rooms: 3,
  });

  console.log("Found properties:", results.length);
  if (results.length > 0) {
    console.log("First result:", {
      id: results[0].property_id,
      title: results[0].representative_title,
      type: results[0].property_type,
      city: results[0].city,
      neighbourhood: results[0].neighbourhood,
      rooms: results[0].rooms,
      price: results[0].price_egp,
      url: results[0].url,
    });
  }
}
main();
