import { PageFrame, PageHeading } from "@/components/shell/page-frame";
import { t } from "@/lib/messages";

/**
 * What a member who isn't an admin sees on an admin's page. The server refuses them anyway.
 * `scope="instance"` is for the install's own settings (Storage), which an instance admin changes.
 */
export const AdminOnly = ({ title, scope = "organization" }: { readonly title: string; readonly scope?: "organization" | "instance" }) => (
  <PageFrame crumbs={[{ label: t("shell.organization") }, { label: title }]}>
    <PageHeading title={title} lede={scope === "instance" ? t("common.instanceAdminsOnly") : t("common.adminsOnly")} />
  </PageFrame>
);
