import { notFound } from "next/navigation";
import { Suspense } from "react";

import { libraryItemIdSchema } from "@ostra/protocol";

import { ItemPage } from "@/components/library/item-page";
import { t } from "@/lib/messages";

export const metadata = { title: t("library.title") };

const LibraryItemPage = async ({ params }: { readonly params: Promise<{ "item-id": string }> }) => {
  const itemId = libraryItemIdSchema.safeParse((await params)["item-id"]);
  if (!itemId.success) notFound();
  return (
    <Suspense>
      <ItemPage key={itemId.data} itemId={itemId.data} />
    </Suspense>
  );
};

export default LibraryItemPage;
