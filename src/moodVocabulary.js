// What a mood can be translated into: AniList's genres (minus the adult
// ones) and the tags that say something about how a show feels, where it's
// set or what it's about. Exact AniList names, checked against its
// MediaTagCollection. Shared by the model's response schema (api/_lib) and
// the client, which drops anything not on these lists.
export const MOOD_GENRES = [
  "Action", "Adventure", "Comedy", "Drama", "Fantasy", "Horror", "Mahou Shoujo", "Mecha", "Music",
  "Mystery", "Psychological", "Romance", "Sci-Fi", "Slice of Life", "Sports", "Supernatural", "Thriller"
];

export const MOOD_TAGS = [
  // feel
  "Iyashikei", "Tragedy", "Coming of Age", "Found Family", "Family Life", "Parenthood", "Philosophy",
  "Episodic", "Anthology", "Slapstick", "Parody", "Satire", "Surreal Comedy", "Noir", "Cute Girls Doing Cute Things",
  "Cute Boys Doing Cute Things", "Revenge", "Survival", "Rehabilitation", "Conspiracy", "Class Struggle",
  // who
  "Anti-Hero", "Ensemble Cast", "Elderly Protagonist", "Female Protagonist", "Male Protagonist", "Primarily Adult Cast", "Primarily Child Cast",
  "Detective", "Robots", "Artificial Intelligence", "Aliens", "Ghost", "Vampire", "Samurai", "Ninja", "Witch",
  "Dragons", "Gods", "Pirates", "Zombie", "Idol", "Delinquents", "Teacher", "Hikikomori",
  // where and when
  "School", "School Club", "College", "Office", "Work", "Rural", "Urban", "Coastal", "Snowscape", "Wilderness", "Desert",
  "Camping", "Outdoor Activities", "Restaurant", "Dungeon", "Historical", "Medieval", "Ancient China", "Dystopian",
  "Post-Apocalyptic", "Space", "Urban Fantasy", "Virtual World", "Isekai",
  // what it's about
  "Food", "Acting", "Drawing", "Writing", "Photography", "Fashion", "Rakugo", "Band", "Classical Music", "Jazz Music",
  "Rock Music", "Dancing", "Martial Arts", "Swordplay", "Espionage", "Guns", "Battle Royale", "Death Game",
  "Magic", "Mythology", "Youkai", "Fairy Tale", "Super Power", "Superhero", "Steampunk", "Curses", "Exorcism", "Wuxia",
  "Alchemy", "Kaiju", "Cyberpunk", "Space Opera", "Time Loop", "Time Manipulation", "Real Robot", "Super Robot",
  "Video Games", "Board Game", "E-Sports", "Shogi", "Go", "Animals", "Astronomy", "Crime", "Economics", "Gambling",
  "Medicine", "Mountaineering", "Otaku Culture", "Politics", "Travel", "War", "Lost Civilization", "Environmental",
  "Marriage", "Religion", "Royal Affairs", "Kingdom Management", "Body Horror", "Cosmic Horror", "Assassins", "Mafia",
  "Military", "Police", "Yakuza", "Aviation", "Cars", "Trains", "Motorcycles", "Agriculture",
  "Love Triangle", "Unrequited Love", "Cohabitation", "Fake Relationship",
  "Baseball", "Basketball", "Boxing", "Cycling", "Football", "Ice Sports", "Swimming", "Tennis", "Table Tennis", "Volleyball",
  // who it's for
  "Josei", "Seinen", "Shoujo", "Shounen", "Kids"
];

// Limits are words, not numbers: asked for a number with nothing to go on,
// the model makes one up ("a long train ride" came back as 12-13 episodes).
// "any" gives it something true to say. moodReading.js turns these into
// episode counts and years.
export const MOOD_LENGTHS = ["any", "film", "tonight", "short", "long"];
export const MOOD_ERAS = ["any", "1970s", "1980s", "1990s", "2000s", "2010s", "2020s", "older", "recent"];

// A mood can also rule out things it would never ask for.
export const AVOID_GENRES = [...MOOD_GENRES, "Ecchi"];
export const AVOID_TAGS = [
  ...MOOD_TAGS,
  "Gore", "Female Harem", "Male Harem", "Mixed Gender Harem", "Full CGI", "Bullying", "Suicide", "Torture", "Slavery"
];
