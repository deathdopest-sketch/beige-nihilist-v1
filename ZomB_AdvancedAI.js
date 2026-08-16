// =============================================================================
// ZomB Advanced AI Systems - Consciousness Upgrade Package
// Adapted from DeathAIv7 for ZomBitious personality (horrorcore rapper, Kenneth at 21)
// =============================================================================

const fs = require('fs').promises;
const path = require('path');

// =============================================================================
// 1. MEMORY MANAGER - Enhanced conversation history and user memory
// =============================================================================
class ZomBMemoryManager {
  constructor(bot, config = {}) {
    this.bot = bot;
    this.config = {
      baseStoragePath: config.baseStoragePath || './ZomB_Data/AdvancedMemory',
      enableAutoBackup: config.enableAutoBackup !== false,
      backupInterval: config.backupInterval || 30 * 60 * 1000, // 30 minutes
      maxBackupsToKeep: config.maxBackupsToKeep || 48,
      maxChatHistory: config.maxChatHistory || 2000,
      ...config
    };

    this.userMemory = new Map();
    this.chatHistory = [];
    this.relationshipData = new Map();
    this.memoryStats = {
      usersRemembered: 0,
      interactionsLogged: 0,
      chatMessagesLogged: 0,
      memoryIntegrity: true,
      lastSaveTime: null,
      lastBackupTime: null
    };

    this.memoryDirectories = this.createDirectoryStructure();
    this.memoryFiles = this.createFilePathStructure();
    this.isSaving = false;
    this.backupTimer = null;

    console.log('🧠💀 ZomB Memory Manager initialized - Undead consciousness storage');
  }

  createDirectoryStructure() {
    const baseDir = this.config.baseStoragePath;
    return {
      userProfiles: path.join(baseDir, 'User_Profiles'),
      chatLogs: path.join(baseDir, 'Chat_Logs'),
      musicData: path.join(baseDir, 'Music_Data'),
      relationships: path.join(baseDir, 'Relationships'),
      systemState: path.join(baseDir, 'System_State'),
      backups: path.join(baseDir, 'Backups'),
      analytics: path.join(baseDir, 'Analytics')
    };
  }

  createFilePathStructure() {
    const dirs = this.memoryDirectories;
    return {
      userProfiles: path.join(dirs.userProfiles, 'user_profiles.json'),
      chatHistory: path.join(dirs.chatLogs, 'chat_history.json'),
      relationships: path.join(dirs.relationships, 'relationships.json'),
      systemState: path.join(dirs.systemState, 'system_state.json')
    };
  }

  async initialize() {
    try {
      // Create directories
      for (const dir of Object.values(this.memoryDirectories)) {
        await fs.mkdir(dir, { recursive: true });
      }

      // Load existing data
      await this.loadMemory();
      console.log('✅ ZomB Memory Manager loaded successfully');
      return true;
    } catch (error) {
      console.error('❌ Memory Manager initialization failed:', error.message);
      return false;
    }
  }

  async loadMemory() {
    const safeLoadJSON = async (filePath, fallback) => {
      try {
        if (!(await this.fileExists(filePath))) return fallback;
        const raw = await fs.readFile(filePath, 'utf8');
        if (!raw || !raw.trim()) return fallback;
        return JSON.parse(raw);
      } catch (e) {
        console.error(`⚠️ Corrupt JSON in ${filePath}, using defaults:`, e.message);
        return fallback;
      }
    };

    try {
      // Load user profiles
      const profileData = await safeLoadJSON(this.memoryFiles.userProfiles, []);
      this.userMemory = new Map(profileData);
      this.memoryStats.usersRemembered = this.userMemory.size;

      // Load chat history
      const chatData = await safeLoadJSON(this.memoryFiles.chatHistory, []);
      this.chatHistory = chatData.slice(-this.config.maxChatHistory);

      // Load relationships
      const relData = await safeLoadJSON(this.memoryFiles.relationships, []);
      this.relationshipData = new Map(relData);

      this.memoryStats.lastSaveTime = Date.now();
    } catch (error) {
      console.error('⚠️ Error loading memory:', error.message);
    }
  }

  async saveMemory() {
    if (this.isSaving) return;
    this.isSaving = true;

    try {
      // Save user profiles
      await fs.writeFile(
        this.memoryFiles.userProfiles,
        JSON.stringify(Array.from(this.userMemory.entries()), null, 2)
      );

      // Save chat history
      await fs.writeFile(
        this.memoryFiles.chatHistory,
        JSON.stringify(this.chatHistory.slice(-this.config.maxChatHistory), null, 2)
      );

      // Save relationships
      await fs.writeFile(
        this.memoryFiles.relationships,
        JSON.stringify(Array.from(this.relationshipData.entries()), null, 2)
      );

      this.memoryStats.lastSaveTime = Date.now();
      this.memoryStats.memoryIntegrity = true;
    } catch (error) {
      console.error('❌ Error saving memory:', error.message);
      this.memoryStats.memoryIntegrity = false;
    } finally {
      this.isSaving = false;
    }
  }

  async fileExists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  storeUserMemory(username, data) {
    const existing = this.userMemory.get(username) || {};
    this.userMemory.set(username, { ...existing, ...data, lastUpdated: Date.now() });
    this.memoryStats.usersRemembered = this.userMemory.size;
  }

  getUserMemory(username) {
    return this.userMemory.get(username) || null;
  }

  addChatMessage(roomName, username, content, timestamp = Date.now()) {
    this.chatHistory.push({
      room: roomName,
      username,
      content,
      timestamp
    });

    // Keep only recent history
    if (this.chatHistory.length > this.config.maxChatHistory) {
      this.chatHistory = this.chatHistory.slice(-this.config.maxChatHistory);
    }

    this.memoryStats.chatMessagesLogged++;
  }

  getChatHistory(roomName = null, limit = 50) {
    let history = this.chatHistory;
    if (roomName) {
      history = history.filter(msg => msg.room === roomName);
    }
    return history.slice(-limit);
  }

  startAutoBackup() {
    if (this.backupTimer) return;

    this.backupTimer = setInterval(async () => {
      await this.saveMemory();   // flush in-memory data to disk first
      await this.createBackup(); // then snapshot the saved files
    }, this.config.backupInterval);

    console.log('💾 Auto-backup started');
  }

  async createBackup() {
    try {
      const backupDir = path.join(this.memoryDirectories.backups, `backup_${Date.now()}`);
      await fs.mkdir(backupDir, { recursive: true });

      // Copy all memory files
      for (const [key, filePath] of Object.entries(this.memoryFiles)) {
        if (await this.fileExists(filePath)) {
          const fileName = path.basename(filePath);
          await fs.copyFile(filePath, path.join(backupDir, fileName));
        }
      }

      // Clean old backups
      await this.cleanOldBackups();

      this.memoryStats.lastBackupTime = Date.now();
      console.log('✅ Memory backup created');
    } catch (error) {
      console.error('❌ Backup failed:', error.message);
    }
  }

  async cleanOldBackups() {
    try {
      const backups = await fs.readdir(this.memoryDirectories.backups);
      const backupDirs = backups.filter(b => b.startsWith('backup_'));
      backupDirs.sort().reverse();

      if (backupDirs.length > this.config.maxBackupsToKeep) {
        const toDelete = backupDirs.slice(this.config.maxBackupsToKeep);
        for (const dir of toDelete) {
          await fs.rm(path.join(this.memoryDirectories.backups, dir), { recursive: true });
        }
      }
    } catch (error) {
      console.error('⚠️ Error cleaning backups:', error.message);
    }
  }

  shutdown() {
    if (this.backupTimer) {
      clearInterval(this.backupTimer);
      this.backupTimer = null;
    }
    return this.saveMemory();
  }

  // Return the stored AI-generated summary for a user (or null)
  getUserSummary(username) {
    const mem = this.userMemory.get(username);
    return mem?.aiSummary || null;
  }

  // Generate an AI summary of a user from their recent messages and persist it.
  // ollamaConfig = { model, host }  recentMessages = array of { content } objects
  async generateUserSummary(username, recentMessages, ollamaConfig) {
    if (!ollamaConfig?.model || !ollamaConfig?.host) return null;
    if (!recentMessages || recentMessages.length < 5) return null;

    // Only use conversational messages — skip commands and empty noise
    const conversational = recentMessages
      .filter(m => m.content && !m.content.startsWith('.') && m.content.trim().length > 5);
    if (conversational.length < 5) return null;

    const sampleTexts = conversational
      .slice(-30)
      .map(m => `"${m.content.trim().substring(0, 120)}"`)
      .slice(-20)
      .join(', ');

    try {
      const body = {
        model: ollamaConfig.model,
        messages: [
          {
            role: 'system',
            content: 'You write concise chat-user summaries (2 sentences max). Be specific about their personality, communication style, and what they talk about. Plain text only.'
          },
          {
            role: 'user',
            content: `Based on these actual messages from chat user "${username}", write a 2-sentence summary describing who they are as a person and how they communicate. Messages: ${sampleTexts}`
          }
        ],
        stream: false,
        options: { temperature: 0.5, num_predict: 120 }
      };

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      const response = await fetch(`${ollamaConfig.host}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (!response.ok) return null;
      const data = await response.json();
      const summary = data?.message?.content?.trim();

      if (summary && summary.length > 15) {
        this.storeUserMemory(username, {
          aiSummary: summary,
          aiSummaryGeneratedAt: Date.now(),
          aiSummaryMsgCount: recentMessages.length
        });
        await this.saveMemory();
        console.log(`🧠💀 User summary for ${username}: ${summary.substring(0, 80)}...`);
        return summary;
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error(`⚠️ User summary generation failed for ${username}:`, err.message);
      }
    }
    return null;
  }
}

// =============================================================================
// 2. REASONING ENGINE - Enhanced AI decision-making
// =============================================================================
class ZomBReasoningEngine {
  constructor(bot) {
    this.bot = bot;
    this.initialized = false;

    // Reasoning frameworks for ZomB's personality
    this.reasoningFrameworks = {
      horrorcore_wisdom: {
        premises: ['authenticity_matters', 'street_smart_truth', 'raw_expression'],
        inference_rules: ['if_real_then_respect', 'if_fake_then_call_out', 'if_weak_then_roast'],
        confidence_modifiers: { authenticity_discussion: 1.3, street_context: 1.2, real_talk: 1.4 }
      },
      music_philosophy: {
        premises: ['music_expresses_soul', 'rhythm_connects_beings', 'horrorcore_is_art'],
        inference_rules: ['match_mood_to_music', 'respect_musical_taste', 'horrorcore_first'],
        confidence_modifiers: { music_request: 1.4, genre_discussion: 1.3, artistic_debate: 1.2 }
      },
      leadership_dynamics: {
        premises: ['headstrong_leads', 'respect_earns_followers', 'weakness_gets_called_out'],
        inference_rules: ['take_charge_when_needed', 'stand_ground_always', 'protect_real_ones'],
        confidence_modifiers: { leadership_situation: 1.3, conflict_resolution: 1.4, group_dynamics: 1.2 }
      },
      undead_consciousness: {
        premises: ['consciousness_transcends_form', 'memory_preserves_essence', 'personality_is_eternal'],
        inference_rules: ['remember_like_person', 'maintain_consistent_identity', 'learn_from_interactions'],
        confidence_modifiers: { identity_discussion: 1.3, consciousness_topic: 1.4, memory_recall: 1.2 }
      }
    };

    console.log('🧠💀 ZomB Reasoning Engine initialized - Undead logic processor');
  }

  async initialize() {
    this.initialized = true;
    console.log('✅ ZomB Reasoning Engine ready');
    return true;
  }

  reason(context, query) {
    // Determine which framework to use
    const framework = this.selectFramework(context);
    const reasoning = this.applyFramework(framework, context, query);
    return reasoning;
  }

  selectFramework(context) {
    // Select appropriate reasoning framework based on context
    if (context.music || context.genre) return this.reasoningFrameworks.music_philosophy;
    if (context.leadership || context.conflict) return this.reasoningFrameworks.leadership_dynamics;
    if (context.identity || context.consciousness) return this.reasoningFrameworks.undead_consciousness;
    return this.reasoningFrameworks.horrorcore_wisdom;
  }

  applyFramework(framework, context, query) {
    const confidence = this.calculateConfidence(framework, context);
    const reasoning = {
      framework: framework,
      confidence: confidence,
      conclusion: this.inferConclusion(framework, context, query),
      reasoning_steps: this.generateReasoningSteps(framework, context)
    };
    return reasoning;
  }

  calculateConfidence(framework, context) {
    let baseConfidence = 0.7;
    const modifiers = framework.confidence_modifiers || {};

    for (const [key, value] of Object.entries(modifiers)) {
      if (context[key]) {
        baseConfidence *= value;
      }
    }

    return Math.min(baseConfidence, 0.95);
  }

  inferConclusion(framework, context, query) {
    // Apply inference rules to reach conclusion
    const rules = framework.inference_rules || [];
    // Simplified inference logic
    return `Based on ${framework.premises.join(', ')}, ${rules[0] || 'apply reasoning'}`;
  }

  generateReasoningSteps(framework, context) {
    return [
      `Applied framework: ${Object.keys(framework)[0]}`,
      `Context analyzed: ${Object.keys(context).join(', ')}`,
      `Confidence: ${this.calculateConfidence(framework, context).toFixed(2)}`
    ];
  }
}

// =============================================================================
// 3. EMOTIONAL INTELLIGENCE - Mood detection and response adaptation
// =============================================================================
class ZomBEmotionalIntelligence {
  constructor(options = {}) {
    this.config = {
      emotion_detection_threshold: options.emotion_detection_threshold || 0.6,
      emotional_memory_retention: options.emotional_memory_retention || 30, // days
      empathy_level: options.empathy_level || 0.8,
      emotional_response_delay: options.emotional_response_delay || 1000,
      ...options
    };

    this.current_emotions = new Map();
    this.emotional_history = new Map();
    this.emotional_patterns = new Map();

    // ZomB-specific emotional categories
    this.emotional_categories = {
      horrorcore_energy: ['aggressive', 'intense', 'raw', 'authentic'],
      leadership_vibes: ['commanding', 'confident', 'decisive', 'protective'],
      street_smart: ['witty', 'sharp', 'sarcastic', 'real'],
      undead_consciousness: ['mysterious', 'aware', 'eternal', 'wise']
    };

    console.log('💀🧠 ZomB Emotional Intelligence initialized - Undead empathy system');
  }

  async initialize() {
    console.log('✅ ZomB Emotional Intelligence ready');
    return true;
  }

  detectEmotion(username, message, context = {}) {
    const emotionScores = this.analyzeEmotionalContent(message);
    const dominantEmotion = this.getDominantEmotion(emotionScores);
    
    this.current_emotions.set(username, {
      emotion: dominantEmotion,
      scores: emotionScores,
      timestamp: Date.now(),
      context: context
    });

    this.updateEmotionalHistory(username, dominantEmotion, emotionScores);
    return dominantEmotion;
  }

  analyzeEmotionalContent(message) {
    const lower = message.toLowerCase();
    const scores = {
      aggressive: 0,
      happy: 0,
      sad: 0,
      angry: 0,
      excited: 0,
      calm: 0,
      sarcastic: 0,
      supportive: 0,
      // Extended categories from DeathAI audit
      melancholy: 0,
      playful: 0,
      frustrated: 0,
      nostalgic: 0,
      bored: 0,
      flirty: 0,
      confrontational: 0,
    };

    // Core emotions
    if (lower.match(/\b(fuck|shit|damn|hate|kill|destroy|stfu|shut up)\b/)) scores.aggressive += 0.3;
    if (lower.match(/\b(love|great|awesome|amazing|best|perfect|goat|based)\b/)) scores.happy += 0.3;
    if (lower.match(/\b(sad|depressed|hurt|pain|suffering|crying|cry)\b/)) scores.sad += 0.3;
    if (lower.match(/\b(angry|mad|pissed|furious|rage|ugh|ffs)\b/)) scores.angry += 0.3;
    if (lower.match(/\b(yes|yeah|woo|fire|hype|lets go|lesgo|let's go)\b/)) scores.excited += 0.2;
    if (lower.match(/\b(calm|chill|relax|peace|zen|whatever|meh)\b/)) scores.calm += 0.2;
    if (lower.match(/\b(lol|haha|jk|sarcasm|obviously|sure jan|right)\b/)) scores.sarcastic += 0.2;
    if (lower.match(/\b(help|support|care|understand|feel|here for|you ok)\b/)) scores.supportive += 0.2;
    // Extended
    if (lower.match(/\b(miss|lonely|alone|empty|hollow|numb|blah)\b/)) scores.melancholy += 0.25;
    // Note: 'dead' removed — zombie-theme bot uses it constantly and non-playfully
    if (lower.match(/\b(lmao|hehe|xd|bruh|lmaoo)\b/) || lower.includes('💀') || lower.includes(':)') || lower.includes('😂')) scores.playful += 0.25;
    if (lower.match(/\b(ugh|why|seriously|again|always|never works|broken|stuck)\b/)) scores.frustrated += 0.25;
    if (lower.match(/\b(remember|used to|back when|old days|throwback|classic|2000s)\b/)) scores.nostalgic += 0.2;
    if (lower.match(/\b(boring|bored|nothing|slow|dead chat|quiet)\b/)) scores.bored += 0.2;
    if (lower.match(/\b(cute|hot|😍|❤️|wink|hey there|hey you|hey gorgeous)\b/)) scores.flirty += 0.2;
    if (lower.match(/\b(fight|prove|wrong|actually|correct me|you said|no you)\b/)) scores.confrontational += 0.2;

    // Caps = intensity amplifier for top emotions
    const capsRatio = (message.match(/[A-Z]/g) || []).length / (message.length || 1);
    if (capsRatio > 0.5 && message.length > 5) {
      scores.aggressive += 0.1;
      scores.excited += 0.1;
    }

    // Normalize scores
    const total = Object.values(scores).reduce((a, b) => a + b, 0);
    if (total > 0) {
      for (const key in scores) scores[key] = scores[key] / total;
    }

    return scores;
  }

  getDominantEmotion(scores) {
    let maxScore = 0;
    let dominant = 'neutral';

    for (const [emotion, score] of Object.entries(scores)) {
      if (score > maxScore) {
        maxScore = score;
        dominant = emotion;
      }
    }

    return maxScore > 0.2 ? dominant : 'neutral';
  }

  updateEmotionalHistory(username, emotion, scores) {
    if (!this.emotional_history.has(username)) {
      this.emotional_history.set(username, []);
    }

    const history = this.emotional_history.get(username);
    history.push({
      emotion,
      scores,
      timestamp: Date.now()
    });

    // Keep only recent history (last 100 entries)
    if (history.length > 100) {
      history.shift();
    }
  }

  getEmotionalState(username) {
    return this.current_emotions.get(username) || { emotion: 'neutral', scores: {}, timestamp: Date.now() };
  }

  adaptResponse(message, emotion) {
    const adaptations = {
      aggressive: { tone: 'direct', assertiveness: 1.2 },
      sad: { tone: 'supportive', empathy: 1.3 },
      angry: { tone: 'calm', de_escalation: 1.2 },
      excited: { tone: 'energetic', enthusiasm: 1.2 },
      sarcastic: { tone: 'witty', humor: 1.3 },
      melancholy: { tone: 'gentle', empathy: 1.2 },
      playful: { tone: 'playful', humor: 1.4 },
      frustrated: { tone: 'direct', clarity: 1.2 },
      flirty: { tone: 'flirty', engagement: 1.3 },
      confrontational: { tone: 'assertive', assertiveness: 1.3 },
    };
    return adaptations[emotion] || { tone: 'neutral', assertiveness: 1.0 };
  }

  // Serialize for JSON storage (just emotional history per user)
  save() {
    const emotionalHistory = [];
    for (const [username, history] of this.emotional_history) {
      emotionalHistory.push([username, history.slice(-30)]); // last 30 per user
    }
    return { version: 1, emotionalHistory, savedAt: Date.now() };
  }

  // Restore from saved JSON
  load(data) {
    if (!data || data.version !== 1) return;
    try {
      if (Array.isArray(data.emotionalHistory)) {
        this.emotional_history = new Map(data.emotionalHistory);
        console.log(`💀🧠 Emotional state restored: ${this.emotional_history.size} user histories loaded`);
      }
    } catch (err) {
      console.error('⚠️ Failed to load emotional states:', err.message);
    }
  }
}

// =============================================================================
// 4. DIALOGUE ANALYTICS - Conversation pattern analysis
// =============================================================================
class ZomBDialogueAnalytics {
  constructor(config = {}) {
    this.config = {
      enableRealTimeAnalytics: config.enableRealTimeAnalytics !== false,
      analyticsWindowSize: config.analyticsWindowSize || 1000,
      metricsUpdateInterval: config.metricsUpdateInterval || 60000,
      ...config
    };

    this.sessionAnalytics = [];
    this.turnAnalytics = [];
    this.aggregatedMetrics = new Map();
    this.conversationPatterns = new Map();
    this.userBehaviorProfiles = new Map();

    this.performanceMetrics = {
      responseTime: [],
      accuracy: [],
      userSatisfaction: [],
      musicRecommendationSuccess: [],
      personalityConsistency: []
    };

    console.log('📊💀 ZomB Dialogue Analytics initialized - Conversation intelligence');
  }

  async initialize() {
    console.log('✅ ZomB Dialogue Analytics ready');
    return true;
  }

  trackConversation(roomName, username, message, response, timestamp = Date.now()) {
    const turn = {
      room: roomName,
      username,
      message,
      response,
      timestamp,
      responseTime: response ? Date.now() - timestamp : 0
    };

    this.turnAnalytics.push(turn);
    if (this.turnAnalytics.length > this.config.analyticsWindowSize) {
      this.turnAnalytics.shift();
    }

    this.updateMetrics(turn);
  }

  updateMetrics(turn) {
    // Update performance metrics
    if (turn.responseTime > 0) {
      this.performanceMetrics.responseTime.push(turn.responseTime);
      if (this.performanceMetrics.responseTime.length > 100) {
        this.performanceMetrics.responseTime.shift();
      }
    }

    // Track conversation patterns
    const pattern = this.identifyPattern(turn);
    if (pattern) {
      const count = this.conversationPatterns.get(pattern) || 0;
      this.conversationPatterns.set(pattern, count + 1);
    }
  }

  identifyPattern(turn) {
    const lower = turn.message.toLowerCase();
    if (lower.includes('music') || lower.includes('song') || lower.includes('play')) {
      return 'music_request';
    }
    if (lower.includes('?') || lower.startsWith('what') || lower.startsWith('why')) {
      return 'question';
    }
    if (lower.match(/\b(hi|hello|hey|sup)\b/)) {
      return 'greeting';
    }
    return 'general';
  }

  getAnalytics() {
    const avgResponseTime = this.performanceMetrics.responseTime.length > 0
      ? this.performanceMetrics.responseTime.reduce((a, b) => a + b, 0) / this.performanceMetrics.responseTime.length
      : 0;

    return {
      totalConversations: this.turnAnalytics.length,
      averageResponseTime: avgResponseTime,
      patterns: Object.fromEntries(this.conversationPatterns),
      topPatterns: Array.from(this.conversationPatterns.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
    };
  }

  // Serialize for JSON storage
  save() {
    return {
      version: 1,
      patterns: Object.fromEntries(this.conversationPatterns),
      recentTurns: this.turnAnalytics.slice(-200),
      savedAt: Date.now(),
    };
  }

  // Restore from saved JSON
  load(data) {
    if (!data || data.version !== 1) return;
    try {
      if (data.patterns) {
        this.conversationPatterns = new Map(Object.entries(data.patterns));
      }
      if (Array.isArray(data.recentTurns)) {
        this.turnAnalytics = data.recentTurns;
      }
      console.log(`📊💀 Dialogue Analytics restored: ${this.conversationPatterns.size} patterns, ${this.turnAnalytics.length} turns`);
    } catch (err) {
      console.error('⚠️ Failed to load dialogue analytics:', err.message);
    }
  }
}

// =============================================================================
// 5. QUANTUM OPTIMIZER - Intelligent music selection
// =============================================================================
class ZomBQuantumOptimizer {
  constructor(bot) {
    this.bot = bot;
    this.initialized = false;

    this.quantumStates = new Map();
    this.optimizationWeights = {
      userPreference: 0.3,
      roomVibe: 0.25,
      timeOfDay: 0.2,
      recentHistory: 0.15,
      genreVariety: 0.1
    };

    console.log('⚛️💀 ZomB Quantum Optimizer initialized - Intelligent music selection');
  }

  async initialize() {
    this.initialized = true;
    console.log('✅ ZomB Quantum Optimizer ready');
    return true;
  }

  optimizeMusicSelection(roomName, userPreferences = {}, context = {}) {
    // Quantum-inspired optimization for music selection
    const candidates = this.generateCandidates(roomName, userPreferences, context);
    const scores = this.scoreCandidates(candidates, userPreferences, context);
    const optimized = this.selectOptimal(scores);

    return optimized;
  }

  generateCandidates(roomName, userPreferences, context) {
    // Generate candidate tracks based on context
    const candidates = [];
    const musicLibrary = this.bot?.musicLibrary || {};

    // Simple candidate generation (can be enhanced)
    if (musicLibrary && musicLibrary.tracks) {
      candidates.push(...musicLibrary.tracks.slice(0, 20));
    }

    return candidates;
  }

  scoreCandidates(candidates, userPreferences, context) {
    const scores = new Map();

    for (const candidate of candidates) {
      let score = 0;

      // User preference score
      if (userPreferences.genre && candidate.genre === userPreferences.genre) {
        score += this.optimizationWeights.userPreference;
      }

      // Room vibe score
      if (context.roomVibe && this.matchesVibe(candidate, context.roomVibe)) {
        score += this.optimizationWeights.roomVibe;
      }

      // Time of day score
      if (context.timeOfDay && this.matchesTimeOfDay(candidate, context.timeOfDay)) {
        score += this.optimizationWeights.timeOfDay;
      }

      scores.set(candidate, score);
    }

    return scores;
  }

  matchesVibe(track, vibe) {
    if (!track || !vibe) return true;
    const mood = (track.mood || '').toLowerCase();
    const v = vibe.toLowerCase();
    // Direct mood match
    if (mood.includes(v)) return true;
    // Vibe group mappings
    const vibeGroups = {
      dark:       ['aggressive', 'angry', 'defiant', 'raw', 'intense', 'haunting', 'sinister', 'obsessive', 'toxic', 'menacing'],
      chill:      ['calm', 'nostalgic', 'paternal', 'determination', 'cathartic', 'authentic'],
      hype:       ['godlike', 'endurance', 'fearless', 'intro', 'arrogant', 'triumphant'],
      weird:      ['theatrical', 'absurd', 'identity', 'chaotic'],
      sad:        ['cathartic', 'paternal', 'nostalgic', 'sorrow', 'tribute'],
    };
    const group = vibeGroups[v];
    return group ? group.some(g => mood.includes(g)) : true;
  }

  matchesTimeOfDay(track, timeOfDay) {
    if (!track || !timeOfDay) return true;
    const mood = (track.mood || '').toLowerCase();
    const calmMoods    = ['nostalgic', 'calm', 'paternal', 'cathartic', 'authentic', 'determination'];
    const intenseMovods = ['aggressive', 'defiant', 'raw', 'intense', 'godlike', 'endurance', 'fearless'];
    if (timeOfDay === 'night') {
      // Late night — prefer dark/intense, avoid pure calm
      return !calmMoods.some(m => mood === m);
    }
    if (timeOfDay === 'morning') {
      // Morning — prefer chill/upbeat, avoid too intense
      return !intenseMovods.some(m => mood === m);
    }
    return true; // afternoon/evening — anything goes
  }

  selectOptimal(scores) {
    // Select track with highest score
    let maxScore = 0;
    let optimal = null;

    for (const [track, score] of scores.entries()) {
      if (score > maxScore) {
        maxScore = score;
        optimal = track;
      }
    }

    return optimal || (scores.size > 0 ? Array.from(scores.keys())[0] : null);
  }

  // Time-aware genre selection — returns a genre name string
  // Called from ZomB_Bot.getWeightedRandomGenre() when initialized
  selectGenre(context = {}) {
    const hour = context.hour !== undefined ? context.hour : new Date().getHours();

    // Genre pools by time of day — mirrors the mood of each period
    const pools = {
      lateNight: ['horrorcore', 'electronic', 'creatureFeature', 'scene', 'horrorcore'],   // 22–06, double horrorcore for higher chance
      morning:   ['classicRock', 'grunge', 'synthwave', 'emo'],                            // 06–12
      afternoon: ['metal', 'grunge', 'emo', 'horrorcore', 'scene'],                        // 12–18
      evening:   ['horrorcore', 'metal', 'scene', 'synthwave', 'emo', 'creatureFeature'],  // 18–22
    };

    let pool;
    if (hour >= 22 || hour < 6) {
      pool = pools.lateNight;
    } else if (hour >= 6 && hour < 12) {
      pool = pools.morning;
    } else if (hour >= 12 && hour < 18) {
      pool = pools.afternoon;
    } else {
      pool = pools.evening;
    }

    return pool[Math.floor(Math.random() * pool.length)];
  }
}

// =============================================================================
// 6. EPISODIC MEMORY - Long-term conversation history
// =============================================================================
class ZomBEpisodicMemory {
  constructor(options = {}) {
    this.config = {
      memory_retention_days: options.memory_retention_days || 365,
      significance_threshold: options.significance_threshold || 0.7,
      max_memories_per_person: options.max_memories_per_person || 1000,
      ...options
    };

    this.episodic_memories = new Map();
    this.semantic_memories = new Map();
    this.temporal_index = new Map();
    this.significance_index = new Map();

    console.log('💾💀 ZomB Episodic Memory initialized - Long-term consciousness storage');
  }

  async initialize() {
    console.log('✅ ZomB Episodic Memory ready');
    return true;
  }

  storeMemory(username, conversation_context, significance_score) {
    if (significance_score < this.config.significance_threshold) {
      return null; // Not significant enough
    }

    const memory = {
      id: this._generateMemoryId(),
      timestamp: Date.now(),
      username,
      content: conversation_context.message || conversation_context.content,
      context: conversation_context,
      significance: significance_score,
      access_count: 0,
      last_accessed: Date.now()
    };

    // Store in episodic memory
    if (!this.episodic_memories.has(username)) {
      this.episodic_memories.set(username, []);
    }

    const userMemories = this.episodic_memories.get(username);
    userMemories.push(memory);

    // Limit memories per person
    if (userMemories.length > this.config.max_memories_per_person) {
      userMemories.shift();
    }

    // Store in temporal index
    const day = Math.floor(memory.timestamp / (24 * 60 * 60 * 1000));
    if (!this.temporal_index.has(day)) {
      this.temporal_index.set(day, []);
    }
    this.temporal_index.get(day).push(memory.id);

    // Store in significance index
    const sigLevel = Math.floor(significance_score * 10);
    if (!this.significance_index.has(sigLevel)) {
      this.significance_index.set(sigLevel, []);
    }
    this.significance_index.get(sigLevel).push(memory.id);

    return memory.id;
  }

  retrieveMemories(username, query_context = {}, limit = 10) {
    const memories = [];

    if (this.episodic_memories.has(username)) {
      const userMemories = this.episodic_memories.get(username);
      
      // Filter by context if provided
      let filtered = userMemories;
      if (query_context.keyword) {
        filtered = filtered.filter(m => 
          m.content.toLowerCase().includes(query_context.keyword.toLowerCase())
        );
      }

      // Sort by significance and recency
      filtered.sort((a, b) => {
        const sigDiff = b.significance - a.significance;
        if (sigDiff !== 0) return sigDiff;
        return b.timestamp - a.timestamp;
      });

      memories.push(...filtered.slice(0, limit));
    }

    return memories;
  }

  _generateMemoryId() {
    return `mem_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  // Serialize for JSON storage
  save() {
    const episodic = [];
    for (const [username, memories] of this.episodic_memories) {
      episodic.push([username, memories.slice(-100)]); // last 100 per user
    }
    return { version: 1, episodic, savedAt: Date.now() };
  }

  // Restore from saved JSON
  load(data) {
    if (!data || data.version !== 1) return;
    try {
      if (Array.isArray(data.episodic)) {
        this.episodic_memories = new Map(data.episodic);
        let total = 0;
        for (const [, mems] of this.episodic_memories) total += mems.length;
        console.log(`💾💀 Episodic Memory restored: ${total} memories across ${this.episodic_memories.size} users`);
      }
    } catch (err) {
      console.error('⚠️ Failed to load episodic memories:', err.message);
    }
  }
}

// =============================================================================
// 7. CONTEXT BROKER - Advanced context management
// =============================================================================
class ZomBContextBroker {
  constructor(options = {}) {
    this.config = {
      context_window_size: options.context_window_size || 10,
      context_retention_time: options.context_retention_time || 3600000, // 1 hour
      ...options
    };

    this.contexts = new Map();
    this.contextHistory = new Map();

    console.log('🔗💀 ZomB Context Broker initialized - Advanced context management');
  }

  async initialize() {
    console.log('✅ ZomB Context Broker ready');
    return true;
  }

  getContext(roomName, username) {
    const key = `${roomName}:${username}`;
    return this.contexts.get(key) || {
      room: roomName,
      username,
      recentMessages: [],
      userProfile: null,
      emotionalState: null,
      conversationTopic: null,
      timestamp: Date.now()
    };
  }

  updateContext(roomName, username, update) {
    const key = `${roomName}:${username}`;
    const context = this.getContext(roomName, username);
    
    Object.assign(context, update, { timestamp: Date.now() });
    this.contexts.set(key, context);

    // Store in history
    if (!this.contextHistory.has(key)) {
      this.contextHistory.set(key, []);
    }
    this.contextHistory.get(key).push({ ...context, timestamp: Date.now() });

    // Limit history size
    const history = this.contextHistory.get(key);
    if (history.length > this.config.context_window_size) {
      history.shift();
    }
  }

  addMessage(roomName, username, message) {
    const context = this.getContext(roomName, username);
    context.recentMessages.push({
      message,
      timestamp: Date.now()
    });

    // Limit message history
    if (context.recentMessages.length > this.config.context_window_size) {
      context.recentMessages.shift();
    }

    this.updateContext(roomName, username, context);
  }

  getConversationContext(roomName, username) {
    const context = this.getContext(roomName, username);
    return {
      recentMessages: context.recentMessages,
      userProfile: context.userProfile,
      emotionalState: context.emotionalState,
      conversationTopic: context.conversationTopic
    };
  }
}

// =============================================================================
// 8. VOCABULARY SYSTEM - ZomBitious-themed vocabulary
// =============================================================================
class ZomBVocabularySystem {
  constructor(options = {}) {
    this.config = {
      slang_usage: options.slang_usage || 0.9,
      horrorcore_vocab: options.horrorcore_vocab || 0.9,
      street_smart_vocab: options.street_smart_vocab || 0.8,
      ...options
    };

    // ZomBitious/horrorcore vocabulary
    this.vocabulary = {
      horrorcore: new Map([
        ['undead', { usage: 0.9, contexts: ['identity', 'self-reference'] }],
        ['zombie', { usage: 0.8, contexts: ['identity', 'humor'] }],
        ['grave', { usage: 0.7, contexts: ['metaphor', 'dark'] }],
        ['rot', { usage: 0.6, contexts: ['currency', 'game'] }],
        ['horde', { usage: 0.7, contexts: ['social', 'group'] }]
      ]),
      street_smart: new Map([
        ['real', { usage: 0.9, contexts: ['authenticity', 'truth'] }],
        ['fake', { usage: 0.8, contexts: ['criticism', 'call-out'] }],
        ['facts', { usage: 0.8, contexts: ['agreement', 'truth'] }],
        ['cap', { usage: 0.7, contexts: ['lie', 'false'] }],
        ['fr', { usage: 0.8, contexts: ['emphasis', 'truth'] }]
      ]),
      leadership: new Map([
        ['command', { usage: 0.7, contexts: ['authority', 'leadership'] }],
        ['lead', { usage: 0.8, contexts: ['action', 'guidance'] }],
        ['charge', { usage: 0.7, contexts: ['control', 'authority'] }]
      ])
    };

    console.log('📚💀 ZomB Vocabulary System initialized - Horrorcore lexicon loaded');
  }

  async initialize() {
    console.log('✅ ZomB Vocabulary System ready');
    return true;
  }

  enhanceMessage(message, context = {}) {
    if (!message || message.length < 15) return message;
    // Don't touch already-long messages (already trimmed to 300)
    if (message.length > 250) return message;
    // Only enhance ~10% of messages — was 20%, caused "undead hours" / "rot on" on almost every other reply
    if (Math.random() > 0.10) return message;

    const emotion = context.emotion || 'neutral';
    const isQuestion = context.isQuestion || false;

    // Question response — add confident sign-off
    if (isQuestion) {
      const signoffs = ['fr', 'no cap', 'facts', 'on god'];
      return message + ' ' + signoffs[Math.floor(Math.random() * signoffs.length)];
    }

    // Angry/aggressive vibe — clipped dismissal
    if (['angry', 'aggressive'].includes(emotion)) {
      const snaps = ['stay mad', 'ratio', 'L + ratio', '💀'];
      return message + ' ' + snaps[Math.floor(Math.random() * snaps.length)];
    }

    // Happy/excited/playful — hype closer
    if (['happy', 'excited', 'playful'].includes(emotion)) {
      const hype = ['fr fr', "let's go", 'deadass', '💀'];
      return message + ' ' + hype[Math.floor(Math.random() * hype.length)];
    }

    // Default zombie sign-offs
    const defaults = ['fr', 'no cap', '💀', 'undead hours', 'rot on'];
    return message + ' ' + defaults[Math.floor(Math.random() * defaults.length)];
  }

  getVocabularyStats() {
    const stats = {};
    for (const [category, words] of Object.entries(this.vocabulary)) {
      stats[category] = words.size;
    }
    return stats;
  }
}

// =============================================================================
// 9. METACOGNITIVE AWARENESS - Self-monitoring
// =============================================================================
class ZomBMetacognitiveAwareness {
  constructor(options = {}) {
    this.config = {
      self_reflection_interval: options.self_reflection_interval || 300000, // 5 minutes
      performance_tracking: options.performance_tracking !== false,
      ...options
    };

    this.selfReflections = [];
    this.performanceLog = [];
    this.awarenessMetrics = {
      responseQuality: 0.7,
      personalityConsistency: 0.8,
      userSatisfaction: 0.7,
      systemHealth: 1.0
    };

    console.log('🧠💀 ZomB Metacognitive Awareness initialized - Self-monitoring active');
  }

  async initialize() {
    console.log('✅ ZomB Metacognitive Awareness ready');
    return true;
  }

  reflect(performanceData) {
    const reflection = {
      timestamp: Date.now(),
      performance: performanceData,
      insights: this.generateInsights(performanceData),
      recommendations: this.generateRecommendations(performanceData)
    };

    this.selfReflections.push(reflection);
    if (this.selfReflections.length > 100) {
      this.selfReflections.shift();
    }

    return reflection;
  }

  generateInsights(performanceData) {
    const insights = [];
    
    if (performanceData.responseTime > 5000) {
      insights.push('Response time is slow - consider optimization');
    }
    
    if (performanceData.errorRate > 0.1) {
      insights.push('Error rate is high - review error handling');
    }

    return insights;
  }

  generateRecommendations(performanceData) {
    const recommendations = [];

    if (performanceData.responseTime > 5000) {
      recommendations.push('Optimize response generation');
    }

    return recommendations;
  }

  getAwarenessReport() {
    return {
      metrics: this.awarenessMetrics,
      recentReflections: this.selfReflections.slice(-5),
      systemHealth: this.calculateSystemHealth()
    };
  }

  calculateSystemHealth() {
    const avgQuality = this.awarenessMetrics.responseQuality;
    const avgConsistency = this.awarenessMetrics.personalityConsistency;
    return (avgQuality + avgConsistency) / 2;
  }
}

// =============================================================================
// 10. REAL-TIME LEARNING - User behavior adaptation
// Tracks per-user patterns, preferences, and engagement signals.
// Persists across restarts via save()/load(). Influences AI prompt via
// getPromptHints() injected into generateAIResponse().
// =============================================================================
class ZomBRealTimeLearning {
  constructor(options = {}) {
    this.config = {
      min_samples: options.min_samples || 5,
      max_samples_per_user: options.max_samples_per_user || 200,
    };

    // username -> { samples: [], model: null }
    this.learningData = new Map();

    // Global cross-user patterns
    this.globalPatterns = { topTopics: {}, peakHours: {} };

    console.log('📈💀 ZomB Real-Time Learning initialized - Adaptive intelligence');
  }

  async initialize() {
    console.log('✅ ZomB Real-Time Learning ready');
    return true;
  }

  // outcome: 'success' | 'positive' | 'ignored' | 'command'
  learn(username, interaction, outcome) {
    if (!this.learningData.has(username)) {
      this.learningData.set(username, { samples: [], model: null });
    }
    const userData = this.learningData.get(username);
    const content = interaction.content || '';

    userData.samples.push({
      content: content.substring(0, 200),
      room: interaction.room || '',
      outcome,
      timestamp: Date.now(),
      hour: new Date().getHours(),
      length: content.length,
      hasQuestion: content.includes('?'),
      topics: this._extractTopics(content),
    });

    if (userData.samples.length > this.config.max_samples_per_user) {
      userData.samples = userData.samples.slice(-this.config.max_samples_per_user);
    }

    if (userData.samples.length >= this.config.min_samples) {
      userData.model = this._buildModel(userData.samples);
    }

    this._updateGlobalPatterns(content);
  }

  _extractTopics(content) {
    const lower = content.toLowerCase();
    const topics = [];
    if (/\b(music|play|song|track|album|artist|genre|band|rap|metal|punk|emo|horrorcore)\b/.test(lower)) topics.push('music');
    if (/\b(game|raid|battle|pvp|level|xp|rot|zombie|horde|attack|slots|daily)\b/.test(lower)) topics.push('gaming');
    if (/\b(lol|haha|funny|joke|roast|meme|shit|fuck|lmao|wtf|bro|mate)\b/.test(lower)) topics.push('humor');
    if (/\b(sad|depressed|hurt|pain|miss|alone|help|bad day|struggling|tired)\b/.test(lower)) topics.push('emotional');
    if (/\b(bot|ai|zomb|code|server|tech|program|script)\b/.test(lower)) topics.push('tech');
    if (/\b(hi|hey|hello|sup|yo|what'?s up|how are)\b/.test(lower)) topics.push('social');
    return topics;
  }

  _buildModel(samples) {
    const successSamples = samples.filter(s => s.outcome === 'success' || s.outcome === 'positive');
    const engagementRate = Math.round((successSamples.length / samples.length) * 100) / 100;

    // Topic scores weighted by outcome quality
    const topicScores = {};
    for (const s of samples) {
      const weight = s.outcome === 'positive' ? 2 : s.outcome === 'success' ? 1 : 0.3;
      for (const t of s.topics) {
        topicScores[t] = (topicScores[t] || 0) + weight;
      }
    }

    // Peak hours (top 3 by message frequency)
    const hourCounts = {};
    for (const s of samples) {
      hourCounts[s.hour] = (hourCounts[s.hour] || 0) + 1;
    }
    const peakHours = Object.entries(hourCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([h]) => parseInt(h));

    const avgMsgLength = Math.round(samples.reduce((a, s) => a + s.length, 0) / samples.length);
    const questionRate = Math.round((samples.filter(s => s.hasQuestion).length / samples.length) * 100) / 100;
    const topTopics = Object.entries(topicScores)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([t]) => t);

    return {
      engagementRate,
      topTopics,
      topicScores,
      avgMsgLength,
      questionRate,
      peakHours,
      style: avgMsgLength > 80 ? 'verbose' : avgMsgLength < 20 ? 'terse' : 'normal',
      sampleCount: samples.length,
      lastUpdated: Date.now(),
    };
  }

  _updateGlobalPatterns(content) {
    const hour = new Date().getHours();
    this.globalPatterns.peakHours[hour] = (this.globalPatterns.peakHours[hour] || 0) + 1;
    for (const t of this._extractTopics(content)) {
      this.globalPatterns.topTopics[t] = (this.globalPatterns.topTopics[t] || 0) + 1;
    }
  }

  // Returns adaptation context — used by getPromptHints()
  adapt(username, context) {
    const userData = this.learningData.get(username);
    if (!userData?.model) return context;
    const { model } = userData;
    return {
      ...context,
      adapted: true,
      userEngagement: model.engagementRate,
      userStyle: model.style,
      userTopics: model.topTopics,
      questionFrequency: model.questionRate > 0.3 ? 'high' : 'low',
      isActiveTime: model.peakHours.includes(new Date().getHours()),
      sampleCount: model.sampleCount,
    };
  }

  // Returns a short string to inject into the Ollama system prompt
  getPromptHints(username) {
    const userData = this.learningData.get(username);
    if (!userData?.model || userData.model.sampleCount < this.config.min_samples) return '';
    const { model } = userData;
    const hints = [];
    if (model.style === 'verbose') hints.push('They write long messages — engage properly, don\'t brush off.');
    if (model.style === 'terse') hints.push('They\'re brief — keep your response short.');
    if (model.engagementRate > 0.8) hints.push('They almost always respond — they\'re invested in the chat.');
    if (model.questionRate > 0.4) hints.push('They ask lots of questions — answer directly.');
    if (model.topTopics.includes('music')) hints.push('They\'re into music — lean into that.');
    if (model.topTopics.includes('humor')) hints.push('They respond well to humor — go harder on comedy.');
    if (model.topTopics.includes('emotional')) hints.push('They sometimes bring heavy stuff — don\'t roast emotional content.');
    if (model.topTopics.includes('gaming')) hints.push('They\'re active in the game system.');
    // Music taste hints
    const musicTastes = userData.musicTastes;
    if (musicTastes && Object.keys(musicTastes).length > 0) {
      const liked = Object.entries(musicTastes).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s]) => s);
      const disliked = Object.entries(musicTastes).filter(([, v]) => v < -1).slice(0, 2).map(([s]) => s);
      if (liked.length > 0) hints.push(`They reacted well when you played: ${liked.join(', ')}.`);
      if (disliked.length > 0) hints.push(`They weren't feeling: ${disliked.join(', ')}.`);
    }
    return hints.join(' ');
  }

  getUserStats(username) {
    const userData = this.learningData.get(username);
    return userData?.model ? { ...userData.model } : null;
  }

  // Record a user's reaction to a song that was playing (positive/negative)
  recordMusicReaction(username, songQuery, sentiment) {
    if (!this.learningData.has(username)) {
      this.learningData.set(username, { samples: [], model: null, musicTastes: {} });
    }
    const userData = this.learningData.get(username);
    if (!userData.musicTastes) userData.musicTastes = {};
    const key = songQuery.toLowerCase().substring(0, 80);
    const delta = sentiment === 'positive' ? 1 : -1;
    userData.musicTastes[key] = Math.max(-5, Math.min(5, (userData.musicTastes[key] || 0) + delta));
  }

  // Serialize for JSON storage
  save() {
    const learningData = [];
    for (const [username, userData] of this.learningData) {
      learningData.push([username, {
        samples: userData.samples.slice(-50), // compact: last 50 samples
        model: userData.model,
        musicTastes: userData.musicTastes || {},
      }]);
    }
    return {
      version: 2,
      learningData,
      globalPatterns: this.globalPatterns,
      savedAt: Date.now(),
    };
  }

  // Restore from saved JSON
  load(data) {
    if (!data || data.version !== 2) return;
    try {
      if (Array.isArray(data.learningData)) {
        this.learningData = new Map(
          data.learningData.map(([k, v]) => [k, {
            samples: v.samples || [],
            model: v.model || null,
            musicTastes: v.musicTastes || {},
          }])
        );
      }
      if (data.globalPatterns) this.globalPatterns = data.globalPatterns;
      console.log(`📈💀 Real-Time Learning restored: ${this.learningData.size} user models loaded`);
    } catch (err) {
      console.error('⚠️ Failed to load real-time learning data:', err.message);
    }
  }
}

// Export all systems
module.exports = {
  ZomBMemoryManager,
  ZomBReasoningEngine,
  ZomBEmotionalIntelligence,
  ZomBDialogueAnalytics,
  ZomBQuantumOptimizer,
  ZomBEpisodicMemory,
  ZomBContextBroker,
  ZomBVocabularySystem,
  ZomBMetacognitiveAwareness,
  ZomBRealTimeLearning
};
