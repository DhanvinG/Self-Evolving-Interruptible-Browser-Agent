(function () {
  function buildArt(base, mid, accent, shadow) {
    return [
      `radial-gradient(circle at 20% 18%, ${accent} 0 8%, transparent 24%)`,
      `radial-gradient(circle at 68% 20%, rgba(255,255,255,0.26) 0 10%, transparent 24%)`,
      `radial-gradient(circle at 74% 72%, ${shadow} 0 18%, transparent 40%)`,
      `radial-gradient(circle at 34% 78%, ${mid} 0 16%, transparent 36%)`,
      `conic-gradient(from 220deg at 50% 52%, ${shadow} 0 12%, ${mid} 12% 30%, ${base} 30% 52%, ${accent} 52% 64%, ${mid} 64% 82%, ${shadow} 82% 100%)`,
      `linear-gradient(145deg, ${base} 0%, ${mid} 52%, ${shadow} 100%)`,
    ].join(", ");
  }

  const categoryMeta = {
    projects: { label: "Project memory" },
    notes: { label: "Understanding" },
    context: { label: "Context" },
    preferences: { label: "Preference" },
    profile: { label: "Profile memory" },
  };

  const seededMemories = [
    {
      id: "audit-proof",
      title: "Successfully completed the SOC2 and integrity audit of security in PickleOS",
      subtitle: "Verified privacy and execution integrity",
      body:
        "The integrity audit confirms that PickleOS achieves a verifiable privacy architecture by isolating sensitive data processing within a trusted execution environment, where the running code is open-source and cryptographically verified via remote attestation.",
      category: "notes",
      updatedAt: "2025-12-08T13:55:00.000Z",
      metaLine: "Dec 8, 2025 - 1:55 PM   Understanding",
      links: ["pickle-os", "tee-enclave", "stress-tests", "security-sync"],
      x: 72,
      y: 27,
      size: 118,
      drift: 11,
      art: buildArt("#f1d7a7", "#8b684f", "rgba(255,255,255,0.84)", "rgba(56,34,18,0.82)"),
    },
    {
      id: "pickle-os",
      title: "Building Pickle OS",
      subtitle: "Long-running product thread",
      body:
        "PickleOS is a personal memory system that captures digital traces and organizes them into episodes, understandings, and hypotheses. It is not framed as productivity software; it is framed as a reflective operating system for memory.",
      category: "projects",
      updatedAt: "2025-11-19T19:15:00.000Z",
      metaLine: "Nov 19, 2025 - 7:15 PM   Episode",
      links: ["audit-proof", "memory-atlas", "voice-workflows", "profile-berkeley"],
      x: 56,
      y: 50,
      size: 126,
      drift: 13,
      art: buildArt("#f2efe8", "#a78c73", "rgba(255,255,255,0.9)", "rgba(41,37,31,0.78)"),
    },
    {
      id: "memory-atlas",
      title: "Spatial memory UI",
      subtitle: "Current exploration",
      body:
        "The prototype turns memory into a living field of linked glass orbs. The right rail acts as a focused inspector while the wider canvas preserves relationships, drift, and ambient context.",
      category: "projects",
      updatedAt: "2026-03-14T10:22:00.000Z",
      metaLine: "Mar 14, 2026 - 10:22 AM   Prototype",
      links: ["pickle-os", "voice-workflows", "email-style", "pm-context"],
      x: 43,
      y: 63,
      size: 110,
      drift: 12,
      art: buildArt("#d7d2cf", "#56636e", "rgba(255,255,255,0.86)", "rgba(18,20,22,0.8)"),
    },
    {
      id: "voice-workflows",
      title: "Voice-first workflows",
      subtitle: "Interface note",
      body:
        "Manual overlays, hotword routing, and explicit remember commands all point toward an assistant that should feel interruptible and lightweight. Memory capture by voice should be as easy as saying one sentence.",
      category: "notes",
      updatedAt: "2026-03-14T09:48:00.000Z",
      metaLine: "Mar 14, 2026 - 9:48 AM   Note",
      links: ["memory-atlas", "pickle-os", "overlay-mode"],
      x: 66,
      y: 71,
      size: 92,
      drift: 15,
      art: buildArt("#d7c2a2", "#6f4f3e", "rgba(255,255,255,0.84)", "rgba(38,25,16,0.82)"),
    },
    {
      id: "tee-enclave",
      title: "Implementing TEE and Nitro Enclave for data security in PickleOS",
      subtitle: "Linked system work",
      body:
        "Trusted execution and isolated runtime design are central to the privacy story. This memory anchors the implementation details behind the audit result.",
      category: "projects",
      updatedAt: "2025-12-02T14:28:00.000Z",
      metaLine: "Dec 2, 2025 - 2:28 PM   Episode",
      links: ["audit-proof", "stress-tests", "security-sync"],
      x: 79,
      y: 63,
      size: 82,
      drift: 10,
      art: buildArt("#d4d7d3", "#7e8c95", "rgba(255,255,255,0.86)", "rgba(48,57,64,0.82)"),
    },
    {
      id: "stress-tests",
      title: "Successfully stress-tested TEE structure in multi memory syncing",
      subtitle: "Validation episode",
      body:
        "Stress testing shows the architecture stays stable under synchronized memory updates and replay-heavy workloads. It is linked directly to trust in the broader memory system.",
      category: "notes",
      updatedAt: "2025-12-04T14:12:00.000Z",
      metaLine: "Dec 4, 2025 - 2:12 PM   Understanding",
      links: ["audit-proof", "tee-enclave", "security-sync"],
      x: 84,
      y: 57,
      size: 88,
      drift: 14,
      art: buildArt("#f0d7bf", "#8f6e51", "rgba(255,255,255,0.86)", "rgba(50,34,20,0.78)"),
    },
    {
      id: "security-sync",
      title: "Privacy and Security meeting with Sanio and Hojin",
      subtitle: "Meeting thread",
      body:
        "Internal privacy review conversations shaped the security claims and the linked implementation priorities. This memory behaves like a connective tissue between product narrative and system work.",
      category: "context",
      updatedAt: "2025-12-05T15:03:00.000Z",
      metaLine: "Dec 5, 2025 - 3:03 PM   Episode",
      links: ["audit-proof", "tee-enclave", "stress-tests"],
      x: 89,
      y: 42,
      size: 76,
      drift: 16,
      art: buildArt("#dad0c6", "#8d8378", "rgba(255,255,255,0.8)", "rgba(55,49,43,0.76)"),
    },
    {
      id: "overlay-mode",
      title: "Persistent overlay click mode",
      subtitle: "Interaction thread",
      body:
        "Show should feel like entering a short-lived manual navigation mode. Number-driven clicks need refresh-on-change behavior so the interface remains fluid after route changes.",
      category: "projects",
      updatedAt: "2026-03-14T09:35:00.000Z",
      metaLine: "Mar 14, 2026 - 9:35 AM   Prototype",
      links: ["voice-workflows", "memory-atlas"],
      x: 37,
      y: 30,
      size: 80,
      drift: 12,
      art: buildArt("#f4c54c", "#8e6b25", "rgba(255,255,255,0.78)", "rgba(68,48,12,0.82)"),
    },
    {
      id: "profile-berkeley",
      title: "UC Berkeley",
      subtitle: "Identity context",
      body:
        "Education context connects strongly to professional framing, application materials, and product-oriented storytelling when memories are reused later.",
      category: "profile",
      updatedAt: "2026-03-09T08:50:00.000Z",
      metaLine: "Mar 9, 2026 - 8:50 AM   Profile",
      links: ["pickle-os", "pm-context", "email-style"],
      x: 28,
      y: 69,
      size: 72,
      drift: 11,
      art: buildArt("#d8d4cf", "#979087", "rgba(255,255,255,0.88)", "rgba(52,49,44,0.78)"),
    },
    {
      id: "pm-context",
      title: "PM internship context",
      subtitle: "Aspirational framing",
      body:
        "Engineering work is often being reframed toward product strategy and product storytelling. This memory colors the tone of summaries, pitches, and written responses.",
      category: "context",
      updatedAt: "2026-03-10T14:25:00.000Z",
      metaLine: "Mar 10, 2026 - 2:25 PM   Context",
      links: ["memory-atlas", "profile-berkeley", "email-style"],
      x: 52,
      y: 18,
      size: 66,
      drift: 14,
      art: buildArt("#cfd8df", "#8ea4bc", "rgba(255,255,255,0.82)", "rgba(56,73,98,0.8)"),
    },
    {
      id: "email-style",
      title: "Concise emails",
      subtitle: "Saved preference",
      body:
        "When drafting emails or message-like content, keep the structure brief, clear, and respectful. This preference should compress output into fewer paragraphs with less filler.",
      category: "preferences",
      updatedAt: "2026-03-13T18:40:00.000Z",
      metaLine: "Mar 13, 2026 - 6:40 PM   Preference",
      links: ["memory-atlas", "profile-berkeley", "pm-context"],
      x: 21,
      y: 44,
      size: 86,
      drift: 13,
      art: buildArt("#e4b17a", "#ab7142", "rgba(255,255,255,0.88)", "rgba(74,42,18,0.8)"),
    },
    {
      id: "thread-fragment",
      title: "Memories should be explorable",
      subtitle: "Design note",
      body:
        "A list is not enough. The UI should make memory relationships visible so users can understand why one note, preference, or project affects another.",
      category: "notes",
      updatedAt: "2026-03-14T10:00:00.000Z",
      metaLine: "Mar 14, 2026 - 10:00 AM   Note",
      links: ["memory-atlas", "voice-workflows"],
      x: 15,
      y: 81,
      size: 54,
      drift: 10,
      art: buildArt("#f0d2ba", "#a77658", "rgba(255,255,255,0.9)", "rgba(77,48,29,0.82)"),
    },
    {
      id: "founder-portrait",
      title: "Founder portrait fragment",
      subtitle: "Ambient memory",
      body:
        "Some memories are not purely textual. They act more like fragments and portraits that supply atmosphere to the wider field.",
      category: "context",
      updatedAt: "2025-12-07T10:20:00.000Z",
      metaLine: "Dec 7, 2025 - 10:20 AM   Episode",
      links: ["pickle-os", "audit-proof"],
      x: 61,
      y: 11,
      size: 70,
      drift: 16,
      art: buildArt("#e8d6bf", "#8d7156", "rgba(255,255,255,0.85)", "rgba(63,45,28,0.82)"),
    },
  ];

  const state = {
    memories: seededMemories.map((memory) => ({ ...memory, fresh: false })),
    selectedId: seededMemories[0].id,
    status: "Memory Atlas is live. Select a bubble or add a new memory.",
  };

  const memoryCloud = document.getElementById("memoryCloud");
  const detailThumb = document.getElementById("detailThumb");
  const detailTitle = document.getElementById("detailTitle");
  const detailMetaLine = document.getElementById("detailMetaLine");
  const detailSubtitle = document.getElementById("detailSubtitle");
  const detailBody = document.getElementById("detailBody");
  const detailCategory = document.getElementById("detailCategory");
  const detailUpdated = document.getElementById("detailUpdated");
  const linkedGrid = document.getElementById("linkedGrid");
  const linkedCount = document.getElementById("linkedCount");
  const conversationThread = document.getElementById("conversationThread");
  const conversationCount = document.getElementById("conversationCount");
  const statusText = document.getElementById("statusText");
  const chatForm = document.getElementById("chatForm");
  const chatInput = document.getElementById("chatInput");
  const deleteMemoryButton = document.getElementById("deleteMemoryButton");

  function getMemoryById(id) {
    return state.memories.find((memory) => memory.id === id) || null;
  }

  function getSelectedMemory() {
    return getMemoryById(state.selectedId);
  }

  function formatUpdatedAt(value) {
    try {
      return new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(value));
    } catch (_) {
      return value;
    }
  }

  function computeGlobeLayout() {
    const total = Math.max(state.memories.length, 1);
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    const centerX = 39;
    const centerY = 51;
    const radiusX = 29;
    const radiusY = 37;

    return state.memories
      .map((memory, index) => {
        const progress = total === 1 ? 0.5 : index / (total - 1);
        const y3 = 1 - progress * 2;
        const ringRadius = Math.sqrt(Math.max(0, 1 - y3 * y3));
        const theta = goldenAngle * index + 0.52;
        const x3 = Math.cos(theta) * ringRadius;
        const z3 = Math.sin(theta) * ringRadius;
        const depth = (z3 + 1) / 2;
        const perspective = 0.58 + depth * 0.72;
        const plotX = centerX + x3 * radiusX * perspective;
        const plotY = centerY + y3 * radiusY + z3 * 2.4;
        const orbScale = perspective;
        const glow = 0.62 + depth * 0.34;
        return {
          ...memory,
          plotX,
          plotY,
          depth,
          orbScale,
          glow,
        };
      })
      .sort((a, b) => a.depth - b.depth);
  }

  function buildConversation(memory) {
    if (Array.isArray(memory.chat) && memory.chat.length) {
      return memory.chat;
    }

    const firstSentence = memory.body.split(/(?<=[.!?])\s+/)[0] || memory.body;
    return [
      {
        role: "assistant",
        text: `${memory.title} is being treated as ${categoryMeta[memory.category].label.toLowerCase()}.`,
      },
      {
        role: "user",
        text: "Why is this memory important right now?",
      },
      {
        role: "assistant",
        text: firstSentence,
      },
    ];
  }

  function renderMemoryField() {
    const selected = getSelectedMemory();
    memoryCloud.innerHTML = "";

    computeGlobeLayout().forEach((memory) => {
      const button = document.createElement("button");
      const isSelected = !!selected && selected.id === memory.id;
      const isMuted = !!selected && selected.id !== memory.id && memory.depth < 0.18;

      button.type = "button";
      button.className = [
        "memory-orb",
        isSelected ? "memory-orb--selected" : "",
        isMuted ? "memory-orb--muted" : "",
        memory.fresh ? "memory-orb--fresh" : "",
      ]
        .filter(Boolean)
        .join(" ");
      button.setAttribute("aria-label", memory.title);
      button.style.setProperty("--x", `${memory.plotX}%`);
      button.style.setProperty("--y", `${memory.plotY}%`);
      button.style.setProperty("--size", `${memory.size}px`);
      button.style.setProperty("--drift", `${memory.drift}s`);
      button.style.setProperty("--orb-scale", memory.orbScale.toFixed(3));
      button.style.setProperty("--orb-opacity", memory.glow.toFixed(3));
      button.style.setProperty("--orb-art", memory.art);
      button.innerHTML = `
        <span class="memory-orb__shadow" aria-hidden="true"></span>
        <span class="memory-orb__surface" aria-hidden="true">
          <span class="memory-orb__art"></span>
          <span class="memory-orb__glint memory-orb__glint--primary"></span>
          <span class="memory-orb__glint memory-orb__glint--secondary"></span>
          <span class="memory-orb__rim"></span>
        </span>
        <span class="memory-orb__label">${memory.title}</span>
      `;
      button.addEventListener("click", () => {
        state.selectedId = memory.id;
        state.status = `Focused "${memory.title}".`;
        render();
      });
      memoryCloud.appendChild(button);
    });
  }

  function renderDetailPanel() {
    const selected = getSelectedMemory();
    deleteMemoryButton.disabled = !selected;

    if (!selected) {
      detailThumb.style.backgroundImage = buildArt(
        "#dad6cf",
        "#b4aea5",
        "rgba(255,255,255,0.88)",
        "rgba(71,66,61,0.8)"
      );
      detailTitle.textContent = "No memory selected";
      detailMetaLine.textContent = "Select a bubble to inspect it.";
      detailSubtitle.textContent = "Focused memory";
      detailBody.textContent =
        "The right rail will show memory content, linked memories, and composer feedback once a bubble is selected.";
      detailCategory.textContent = "Empty";
      detailUpdated.textContent = "";
      linkedCount.textContent = "0";
      conversationCount.textContent = "0";
      linkedGrid.innerHTML = '<div class="linked-empty">No linked memories yet.</div>';
      conversationThread.innerHTML = '<div class="conversation-empty">Select an orb to inspect its conversation.</div>';
      return;
    }

    detailThumb.style.backgroundImage = [
      "radial-gradient(circle at 32% 26%, rgba(255,255,255,0.94), transparent 24%)",
      "radial-gradient(circle at 68% 78%, rgba(0,0,0,0.26), transparent 48%)",
      selected.art,
    ].join(", ");
    detailTitle.textContent = selected.title;
    detailMetaLine.textContent =
      selected.metaLine || `${formatUpdatedAt(selected.updatedAt)}   ${categoryMeta[selected.category].label}`;
    detailSubtitle.textContent = selected.subtitle;
    detailBody.textContent = selected.body;
    detailCategory.textContent = categoryMeta[selected.category].label;
    detailUpdated.textContent = `Updated ${formatUpdatedAt(selected.updatedAt)}`;

    const linked = (selected.links || [])
      .map((linkId) => getMemoryById(linkId))
      .filter(Boolean);
    const conversation = buildConversation(selected);

    linkedCount.textContent = String(linked.length);
    conversationCount.textContent = String(conversation.length);
    linkedGrid.innerHTML = "";
    conversationThread.innerHTML = "";

    if (!linked.length) {
      linkedGrid.innerHTML = '<div class="linked-empty">This memory is currently floating on its own.</div>';
    } else {
      linked.forEach((memory) => {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "linked-card";
        card.style.setProperty("--card-art", memory.art);
        card.innerHTML = `
          <span class="linked-card__thumb"></span>
          <span class="linked-card__body">
            <span class="linked-card__title">${memory.title}</span>
            <span class="linked-card__meta">${memory.metaLine || categoryMeta[memory.category].label}</span>
          </span>
        `;
        card.addEventListener("click", () => {
          state.selectedId = memory.id;
          state.status = `Jumped to linked memory "${memory.title}".`;
          render();
        });
        linkedGrid.appendChild(card);
      });
    }

    conversation.forEach((entry) => {
      const bubble = document.createElement("div");
      bubble.className = `conversation-bubble conversation-bubble--${entry.role}`;
      bubble.innerHTML = `
        <span class="conversation-bubble__role">${entry.role === "assistant" ? "Cora" : "You"}</span>
        <span>${entry.text}</span>
      `;
      conversationThread.appendChild(bubble);
    });
  }

  function updateStatus() {
    statusText.textContent = state.status;
  }

  function render() {
    renderMemoryField();
    renderDetailPanel();
    updateStatus();
  }

  function slugify(value) {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 36);
  }

  function normalizeSentence(value) {
    const trimmed = value.trim().replace(/\s+/g, " ");
    if (!trimmed) return "";
    const sentence = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
    return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
  }

  function deriveCategory(text) {
    if (/\bprefer|favorite|usually|default|tend to\b/i.test(text)) {
      return "preferences";
    }
    if (/\bmy name is|my email is|my phone|my company is|my role is|my school is|my bio is|my skills\b/i.test(text)) {
      return "profile";
    }
    if (/\bbuilding|working on|project|prototype|launch|ship|designing\b/i.test(text)) {
      return "projects";
    }
    if (/\bcontext|goal|applying|interested in|background\b/i.test(text)) {
      return "context";
    }
    return "notes";
  }

  function deriveTitle(text) {
    const cleaned = text.replace(/^remember\b/i, "").replace(/^that\b/i, "").trim();
    if (!cleaned) return "New memory";
    return cleaned.length > 64 ? `${cleaned.slice(0, 61)}...` : cleaned;
  }

  function computePlacement(index) {
    const x = 12 + ((index * 17) % 74);
    const y = 14 + ((index * 13) % 68);
    return { x, y };
  }

  function deriveArt(category, index) {
    const palette = {
      projects: [
        ["#ddd8d0", "#7e8a95", "rgba(255,255,255,0.86)", "rgba(43,52,61,0.82)"],
        ["#f0d5bb", "#8d684b", "rgba(255,255,255,0.88)", "rgba(55,33,18,0.82)"],
      ],
      notes: [
        ["#ead7c2", "#996d4d", "rgba(255,255,255,0.88)", "rgba(68,43,24,0.82)"],
        ["#d7d3cf", "#6b6e77", "rgba(255,255,255,0.84)", "rgba(34,36,40,0.82)"],
      ],
      context: [
        ["#d5d8db", "#8b8d92", "rgba(255,255,255,0.82)", "rgba(56,58,61,0.78)"],
        ["#e6d4bf", "#866c55", "rgba(255,255,255,0.84)", "rgba(56,42,31,0.8)"],
      ],
      preferences: [
        ["#efc28d", "#ab7245", "rgba(255,255,255,0.88)", "rgba(73,43,18,0.82)"],
        ["#d0d7df", "#8795a7", "rgba(255,255,255,0.84)", "rgba(53,63,78,0.82)"],
      ],
      profile: [
        ["#ddd7d0", "#8b847a", "rgba(255,255,255,0.88)", "rgba(58,52,46,0.8)"],
        ["#d9d4cb", "#7e8793", "rgba(255,255,255,0.84)", "rgba(49,55,63,0.82)"],
      ],
    };

    const options = palette[category] || palette.notes;
    const selected = options[index % options.length];
    return buildArt(selected[0], selected[1], selected[2], selected[3]);
  }

  function findRelatedMemories(text, category) {
    const tokens = new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s]+/g, " ")
        .split(/\s+/)
        .filter((token) => token.length > 3)
    );

    return state.memories
      .map((memory) => {
        let score = memory.category === category ? 1 : 0;
        const haystack = `${memory.title} ${memory.subtitle} ${memory.body}`.toLowerCase();
        tokens.forEach((token) => {
          if (haystack.includes(token)) score += 1;
        });
        return { id: memory.id, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4)
      .map((entry) => entry.id);
  }

  function createMemoryFromInput(rawText) {
    const cleaned = rawText.replace(/^remember\b/i, "").trim() || rawText.trim();
    const category = deriveCategory(cleaned);
    const placement = computePlacement(state.memories.length + 1);
    const title = deriveTitle(cleaned);
    const updatedAt = new Date().toISOString();

    return {
      id: `memory-${slugify(title)}-${Date.now().toString(36)}`,
      title,
      subtitle: categoryMeta[category].label,
      body: normalizeSentence(cleaned),
      category,
      updatedAt,
      metaLine: `${formatUpdatedAt(updatedAt)}   ${categoryMeta[category].label}`,
      links: findRelatedMemories(cleaned, category),
      x: placement.x,
      y: placement.y,
      size: category === "profile" || category === "projects" ? 92 : 82,
      drift: 10 + ((state.memories.length + 1) % 5),
      art: deriveArt(category, state.memories.length + 1),
      chat: [
        {
          role: "user",
          text: rawText,
        },
        {
          role: "assistant",
          text: `Saved as ${categoryMeta[category].label.toLowerCase()}.`,
        },
        {
          role: "assistant",
          text: normalizeSentence(cleaned),
        },
      ],
      fresh: true,
    };
  }

  function removeMemory(memoryId) {
    const target = getMemoryById(memoryId);
    if (!target) return;

    state.memories = state.memories
      .filter((memory) => memory.id !== memoryId)
      .map((memory) => ({
        ...memory,
        links: (memory.links || []).filter((linkId) => linkId !== memoryId),
      }));

    if (!state.memories.length) {
      state.selectedId = null;
      state.status = `Removed "${target.title}". The field is now empty.`;
      render();
      return;
    }

    const fallback = state.memories.find((memory) => (target.links || []).includes(memory.id)) || state.memories[0];
    state.selectedId = fallback.id;
    state.status = `Removed "${target.title}" from the constellation.`;
    render();
  }

  chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const rawText = chatInput.value.trim();
    if (!rawText) return;

    const newMemory = createMemoryFromInput(rawText);
    state.memories = state.memories.map((memory) => ({ ...memory, fresh: false }));
    state.memories.push(newMemory);

    newMemory.links.forEach((linkId) => {
      const linked = getMemoryById(linkId);
      if (!linked) return;
      if (!(linked.links || []).includes(newMemory.id)) {
        linked.links = [...(linked.links || []), newMemory.id];
      }
    });

    state.selectedId = newMemory.id;
    state.status = `Saved "${newMemory.title}" as a ${categoryMeta[newMemory.category].label.toLowerCase()}.`;
    chatInput.value = "";
    render();

    window.setTimeout(() => {
      const created = getMemoryById(newMemory.id);
      if (!created) return;
      created.fresh = false;
      render();
    }, 1400);
  });

  deleteMemoryButton.addEventListener("click", () => {
    const selected = getSelectedMemory();
    if (!selected) return;
    removeMemory(selected.id);
  });

  render();
})();
