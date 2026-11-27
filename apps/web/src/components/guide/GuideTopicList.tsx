"use client";

import { useId, useState } from "react";

import { guideTopics, type GuideTopic } from "./guide-content";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Every query word must appear somewhere in the topic's id, title, summary or step text.
function matches(topic: GuideTopic, words: string[]): boolean {
  const text = [topic.id, topic.title, topic.summary, ...topic.steps.flatMap((s) => [s.title, s.body])]
    .join(" ")
    .toLowerCase();
  return words.every((w) => text.includes(w));
}

/** Searchable "All guides" index: the search field stays in view while the matching topics scroll. */
export function GuideTopicList({ onPick }: { onPick: (id: string) => void }) {
  const inputId = useId();
  const [query, setQuery] = useState("");
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const topics = words.length ? guideTopics.filter((t) => matches(t, words)) : guideTopics;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 flex-col gap-1.5">
        <Label htmlFor={inputId}>Search guides</Label>
        <Input
          id={inputId}
          type="search"
          placeholder="Search guides"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
        {topics.length ? (
          <ul className="flex flex-col gap-1">
            {topics.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => onPick(t.id)}
                  className="flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <span className="text-sm font-medium">{t.title}</span>
                  <span className="text-xs text-muted-foreground">{t.summary}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-3 py-2 text-sm text-muted-foreground">No guides match your search.</p>
        )}
      </div>
    </div>
  );
}
