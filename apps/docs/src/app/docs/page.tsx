import { redirect } from "next/navigation";

// `/docs` opens the first page of the first section.
const DocsIndex = () => {
  redirect("/docs/start/what-ostra-is");
};

export default DocsIndex;
