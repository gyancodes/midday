import { getTransactions } from "@midday/gocardless";
import { revalidateTag } from "next/cache";
import { client, supabase } from "../client";
import { Events, Jobs } from "../constants";
import { transformTransactions } from "../utils";
import { scheduler } from "./scheduler";

client.defineJob({
  id: Jobs.TRANSACTIONS_SYNC,
  name: "🔄 Transactions - Latest Transactions",
  version: "1.0.2",
  trigger: scheduler,
  integrations: { supabase },
  run: async (_, io, ctx) => {
    const { data } = await io.supabase.client
      .from("bank_accounts")
      .select("id,team_id,account_id")
      .eq("id", ctx.source.id)
      .single();

    const teamId = data?.team_id;

    // Update bank account last_accessed
    await io.supabase.client
      .from("bank_accounts")
      .update({
        last_accessed: new Date().toISOString(),
      })
      .eq("id", ctx.source.id);

    revalidateTag(`bank_accounts_${teamId}`);
    await io.logger.info(`bank_accounts_${teamId}`);

    if (!data) {
      await io.logger.error(`Bank account not found: ${ctx.source.id}`);
      await scheduler.unregister(ctx.source.id);
      // TODO: Delete requisitions
    }

    const { transactions } = await getTransactions(data?.account_id);

    const { data: transactionsData, error } = await io.supabase.client
      .from("transactions")
      .upsert(
        transformTransactions(transactions?.booked, {
          accountId: data?.id,
          teamId,
        }),
        {
          onConflict: "internal_id",
          ignoreDuplicates: false,
        }
      )
      .select();

    if (transactionsData && transactionsData.length > 0) {
      await io.logger.log(`Sending notifications: ${transactionsData.length}`);

      revalidateTag(`transactions_${teamId}`);
      revalidateTag(`spending_${teamId}`);
      revalidateTag(`metrics_${teamId}`);

      await io.sendEvent("🔔 Send notifications", {
        name: Events.TRANSACTIONS_NOTIFICATION,
        payload: {
          teamId,
          transactions: transactionsData,
        },
      });

      await io.sendEvent("💅 Enrich Transactions", {
        name: Events.TRANSACTIONS_ENCRICHMENT,
        payload: {
          teamId,
        },
      });
    }

    if (error) {
      await io.logger.error(JSON.stringify(error, null, 2));
    }

    await io.logger.info(`Transactions Created: ${transactionsData?.length}`);
  },
});
