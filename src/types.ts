export interface DiscoursePoster {
  user_id?: number;
  username?: string;
  primary_group_id?: number | null;
}

export interface DiscourseTopic {
  id: number;
  slug?: string;
  title?: string;
  fancy_title?: string;
  created_at?: string;
  last_posted_at?: string;
  bumped_at?: string;
  category_id?: number;
  posters?: DiscoursePoster[];
  posts_count?: number;
  reply_count?: number;
  views?: number;
  like_count?: number;
  has_accepted_answer?: boolean;
  solved?: boolean;
  last_poster_username?: string;
  excerpt?: string;
  tags?: string[];
}

export interface DiscourseUser {
  id: number;
  username: string;
}

export interface DiscoursePost {
  id: number;
  topic_id?: number;
  username?: string;
  created_at: string;
  cooked: string;
  excerpt?: string;
  accepted_answer?: boolean;
  slug?: string;
}

export interface DiscourseTopicListResponse {
  topic_list: { topics: DiscourseTopic[] };
  users?: DiscourseUser[];
}

export interface DiscourseSearchResponse {
  topics?: DiscourseTopic[];
  posts?: DiscoursePost[];
  users?: DiscourseUser[];
}

export interface DiscourseThreadResponse {
  id: number;
  slug: string;
  title: string;
  created_at: string;
  posts_count: number;
  views: number;
  has_accepted_answer?: boolean;
  tags?: string[];
  post_stream?: { posts: DiscoursePost[]; stream?: number[] };
}

export interface ApiItem {
  Name: string;
  Value: number;
}

export interface ApiEnum {
  Name: string;
  Items: ApiItem[];
}

export interface ApiSecurity {
  Read?: string;
  Write?: string;
}

export interface ApiParameter {
  Name: string;
  Type: { Name: string };
  Default?: string;
}

export interface ApiMember {
  Name: string;
  MemberType: "Property" | "Function" | "Event" | "Callback" | string;
  Category?: string;
  Security?: string | ApiSecurity;
  ValueType?: { Name: string; Category?: string };
  Parameters?: ApiParameter[];
  ReturnType?: { Name: string };
  Tags?: (string | Record<string, unknown>)[];
  Description?: string;
}

export interface ApiClass {
  Name: string;
  Superclass?: string;
  Members?: ApiMember[];
  Tags?: (string | Record<string, unknown>)[];
  Description?: string;
}

export interface ApiDump {
  Classes: ApiClass[];
  Enums: ApiEnum[];
  Version: number;
}

export interface StatusComponent {
  name: string;
  status: string;
  description?: string;
}

export interface StatusIncident {
  name: string;
  status: string;
  shortlink?: string;
}

export interface StatusPage {
  page: { name: string; url: string };
  components: StatusComponent[];
  incidents: StatusIncident[];
}

export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
}

export interface ForumSearchHit {
  id: number;
  title: string;
  url: string;
  author: string;
  category_id?: number;
  tags: string[];
  replies: number;
  views: number;
  likes: number;
  createdAt: string;
  lastActivityAt?: string;
  isSolved: boolean;
  excerpt?: string;
  score: number;
}

export interface ApiClassSummary {
  name: string;
  superclass?: string;
  inheritanceChain: string[];
  tags: string[];
  description?: string;
  docsUrl: string;
  members: {
    properties: ApiMemberSummary[];
    methods: ApiMemberSummary[];
    events: ApiMemberSummary[];
    callbacks: ApiMemberSummary[];
  };
}

export interface ApiMemberSummary {
  name: string;
  kind: string;
  type?: string;
  parameters?: { name: string; type: string; default?: string }[];
  returnType?: string;
  tags: string[];
  description?: string;
}
