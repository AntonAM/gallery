import { Kysely, sql } from 'kysely';

// Asset versions (specs/2026-11-07-asset-versions-design.md, "Face boxes on a shown edit"): where the picture a base
// photo shows sits on the photo's own, found from the faces on both, so that face and text boxes follow a cropped edit.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset_version" ADD "placement" jsonb;`.execute(db);
}

// "Moving the data back" for derived data: the placement is worked out from the two pictures and found again when
// needed, and nothing else was written because of it (no face is hidden or moved), so it is dropped.
export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset_version" DROP COLUMN "placement";`.execute(db);
}
