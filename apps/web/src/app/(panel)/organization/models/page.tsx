import { AdminOnly } from "@/components/common/admin-only";
import { ModelsView } from "@/components/models/models-view";
import { t } from "@/lib/messages";
import { isAdmin } from "@/server/viewer";

export const metadata = { title: t("models.title") };

const ModelsPage = async () => ((await isAdmin()) ? <ModelsView /> : <AdminOnly title={t("models.title")} />);

export default ModelsPage;
