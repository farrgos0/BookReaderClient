using System.Text.Json;
using System.Text.Json.Nodes;

namespace BookReaderClient.Services;

/// <summary>
/// Личные правила произношения. Их ведёт веб-интерфейс (pron.js) и кладёт сюда через SetPref("pron", json);
/// нативная озвучка добавляет к каждому запросу к серверу правила, которые действуют для книги:
///   "rules": [{ "w": "гг", "c": false, "s": "главный герой" }], "opts": { "date_order": "mdy" }.
/// Правило без списка книг (books = null) — для всех книг.
/// </summary>
public static class PronStore
{
    const string PrefKey = "ui_pron";
    static readonly object sync = new();
    static string? raw;
    static JsonObject? parsed;

    static JsonObject? Data()
    {
        var now = Preferences.Default.Get<string?>(PrefKey, null);
        lock (sync)
        {
            if (now == raw) return parsed;
            raw = now;
            try { parsed = string.IsNullOrEmpty(now) ? null : JsonNode.Parse(now) as JsonObject; }
            catch { parsed = null; }
            return parsed;
        }
    }

    /// <summary>Поля для JSON запроса озвучки: (rules, opts); null — нечего добавлять.</summary>
    public static (JsonArray? Rules, JsonObject? Opts) For(string? bookId)
    {
        var d = Data();
        if (d == null) return (null, null);
        JsonArray? rules = null;
        if (d["rules"] is JsonArray all)
        {
            foreach (var n in all)
            {
                if (n is not JsonObject r) continue;
                var w = r["w"]?.GetValue<string>();
                var s = r["s"]?.GetValue<string>();
                if (string.IsNullOrWhiteSpace(w) || string.IsNullOrWhiteSpace(s)) continue;
                if (r["books"] is JsonArray books && !books.Any(b => b?.GetValue<string>() == bookId)) continue;
                rules ??= new JsonArray();
                rules.Add(new JsonObject { ["w"] = w, ["c"] = r["c"]?.GetValue<bool>() ?? false, ["s"] = s });
            }
        }
        JsonObject? opts = null;
        var order = (d["opts"] as JsonObject)?["date_order"]?.GetValue<string>();
        if (order is "mdy") opts = new JsonObject { ["date_order"] = order };
        return (rules, opts);
    }

    /// <summary>Добавить правила книги в JSON-объект запроса.</summary>
    public static JsonObject Attach(JsonObject req, string? bookId)
    {
        var (rules, opts) = For(bookId);
        if (rules != null) req["rules"] = rules;
        if (opts != null) req["opts"] = opts;
        return req;
    }

    /// <summary>Отпечаток действующего для книги набора (меняется вместе с правилами).</summary>
    public static string Stamp(string? bookId)
    {
        var (rules, opts) = For(bookId);
        return (rules?.ToJsonString() ?? "") + "|" + (opts?.ToJsonString() ?? "");
    }
}
