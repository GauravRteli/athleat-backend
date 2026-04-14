const { createClient } = require("@supabase/supabase-js");
const env = require("./env");

function getSupabaseAdminClient() {
  if (!env.supabaseApi.url || !env.supabaseApi.serviceRoleKey) {
    return null;
  }

  return createClient(env.supabaseApi.url, env.supabaseApi.serviceRoleKey, {
    auth: { persistSession: false },
  });
}

module.exports = {
  getSupabaseAdminClient,
};
