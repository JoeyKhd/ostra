"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { SubmitEvent } from "react";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SheetClose, SheetContent } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

/** New pool (runners.md): a name, whether each new runner needs approval, and a cap on boxes. */
export const NewPoolSheet = ({ onCreated }: { readonly onCreated: (poolId: string) => void }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [maxBoxes, setMaxBoxes] = useState("");
  const create = useMutation(
    trpc.pools.create.mutationOptions({
      onSuccess: async ({ poolId }) => {
        await queryClient.invalidateQueries({ queryKey: trpc.pools.list.queryKey() });
        onCreated(poolId);
      },
    }),
  );
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    const cap = maxBoxes === "" ? null : Number.parseInt(maxBoxes, 10);
    create.mutate({ name: name.trim(), requiresApproval, maxBoxes: cap !== null && Number.isFinite(cap) && cap > 0 ? cap : null });
  };
  const clash = create.error?.data?.code === "CONFLICT";
  return (
    <SheetContent title={t("runners.newPoolTitle")}>
      <form onSubmit={submit} noValidate className="flex h-full flex-col px-[18px] py-5">
        <h2 className="mb-4 text-[16.5px] font-semibold">{t("runners.newPoolTitle")}</h2>
        <Field id="pool-name" label={t("runners.poolName")} error={clash ? t("runners.poolNameTaken") : null}>
          <Input
            id="pool-name"
            required
            maxLength={64}
            autoComplete="off"
            aria-invalid={clash}
            value={name}
            onChange={(e) => { setName(e.target.value); create.reset(); }}
          />
        </Field>
        <div className="mb-3.5 flex items-center justify-between gap-3">
          <label htmlFor="pool-approval" className="text-body text-text">{t("runners.poolRequiresApproval")}</label>
          <Switch id="pool-approval" checked={requiresApproval} onCheckedChange={setRequiresApproval} />
        </div>
        <Field id="pool-max" label={t("runners.poolMaxBoxes")} help={t("runners.poolMaxBoxesHelp")}>
          <Input id="pool-max" inputMode="numeric" className="font-mono" value={maxBoxes} onChange={(e) => { setMaxBoxes(e.target.value.replace(/\D/g, "")); }} placeholder={t("runners.noLimit")} />
        </Field>
        {create.error === null || clash ? null : <p role="alert" className="mb-3 text-ui text-red">{errorText(create.error)}</p>}
        <div className="mt-1 flex gap-2">
          <SheetClose asChild>
            <Button type="button">{t("common.cancel")}</Button>
          </SheetClose>
          <Button type="submit" variant="primary" disabled={create.isPending || name.trim() === ""}>
            {create.isPending ? t("runners.creatingPool") : t("runners.createPool")}
          </Button>
        </div>
      </form>
    </SheetContent>
  );
};
