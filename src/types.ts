/**
 * Raw response shapes from Colleague Self-Service, narrowed to the fields we
 * consume. Shared between the extension (which fetches them) and the app
 * (which interprets them), so it must stay free of browser or DOM concerns.
 */

export interface CodeDescription {
  Code: string;
  Description: string;
}

export interface Facet {
  Value: string;
  Description: string;
  Count: number;
  Selected: boolean;
}

export interface CatalogVocabulary {
  Subjects: { Code: string; Description: string; ShowInCourseSearch: boolean }[];
  /** Tuples arrive as Item1 = code, Item2 = description. */
  Terms: { Item1: string; Item2: string }[];
  Locations: { Item1: string; Item2: string }[];
  AcademicLevels: { Item1: string; Item2: string }[];
  DaysOfWeek: { Item1: string; Item2: string; Item3: boolean }[];
}

export interface ProgramSummary {
  Code: string;
  Title: string;
  Degree: string;
  AcademicLevelCode: string;
  Majors: string[];
  Minors: string[];
  IsActive: boolean;
}

export interface CourseRef {
  Id: string;
  SubjectCode: string;
  Number: string;
  Title: string;
  CourseName: string;
  EquatedCourseIds: string[] | null;
  IsPseudoCourse: boolean;
}

export interface AppliedCredit {
  Id: string;
  CourseId: string;
  CourseName: string;
  Title: string;
  Credit: number;
  VerifiedGrade: string | null;
  Term: string;
  IsCompletedCredit: boolean;
  IsTransferCourse: boolean;
  IsWithdrawn: boolean;
  IsExtraCourse: boolean;
  AllowedByOverride: boolean;
  ReplacedStatus: string;
  ReplacementStatus: string;
}

export interface RawGroup {
  Id: string;
  Code: string;
  /** Catalog coordinates; the course search accepts these to expand a rule. */
  RequirementCode?: string;
  SubrequirementId?: string;
  DisplayText: string;
  CompletionStatus: string;
  PlanningStatus: string;
  Courses: CourseRef[] | null;
  FromCourses: CourseRef[] | null;
  FromSubjects: { Code: string; Description: string }[] | null;
  FromDepartments: { Code: string; Description: string }[] | null;
  FromLevels: string[] | null;
  ButNotCourses: CourseRef[] | null;
  ButNotSubjects: { Code: string }[] | null;
  ButNotCourseLevels: string[] | null;
  MinCourses: number | null;
  MinCredits: number | null;
  MinCreditsPerCourse: number | null;
  MinSubjects: number | null;
  MinDepartments: number | null;
  MaxCourses: number | null;
  MaxCredits: number | null;
  MaxCreditsPerCourse: number | null;
  AppliedAcademicCredits: AppliedCredit[] | null;
  CoursesThatNeedPlanned: CourseRef[] | null;
  AcademicCreditRules: string[] | null;
  /** The registrar's own note when a requirement was modified by hand. */
  ModificationMessages?: string[] | null;
  HasRules: boolean;
  OnlyConveysPrintText: boolean;
}

export interface RawSubrequirement {
  Id: string;
  Code: string;
  DisplayText: string;
  CompletionStatus: string;
  PlanningStatus: string;
  MinGroups: number | null;
  MinGpa: string | null;
  MinInstitutionalCredits: number | null;
  Groups: RawGroup[];
}

export interface RawRequirement {
  Id: string;
  Code: string;
  Description: string;
  CompletionStatus: string;
  PlanningStatus: string;
  MinSubrequirements: number | null;
  MinGpa: string | null;
  Subrequirements: RawSubrequirement[];
}

export interface EvaluationResponse {
  StudentId: string;
  Program: {
    Code: string;
    Title: string;
    Catalog: string;
    Degree: string;
    MinimumCredits: number;
    CompletedCredits: number;
    InProgressCredits: number;
    PlannedCredits: number;
    Requirements: RawRequirement[];
    RequiredRequirementCount: number;
    CompletedRequirementCount: number;
    /**
     * What the program is made of, in words a student would use. A single
     * enrolment carries several: "BS.CYOPR" is a cyber operations major *and*
     * the honors program, and only these arrays say so.
     */
    Majors?: string[] | null;
    Minors?: string[] | null;
  };
}

/**
 * A course on Colleague's own degree plan.
 *
 * `SectionId` is the field that matters most here: set, the student has picked
 * a section, and this planner treats the entry as none of its business.
 */
export interface PlannedCourseDto {
  CourseId: string;
  SectionId: string | null;
  TermId: string;
  Credits: number | null;
  GradingType?: string;
  AddedBy?: string;
  AddedOn?: string;
  IsProtected?: boolean;
  CoursePlaceholderId?: string | null;
}

/**
 * The plan as the write endpoints want it handed back.
 *
 * Every mutation carries the whole DTO and returns the updated copy, Version
 * and all. That is Ellucian's concurrency check, and the reason a sync runs in
 * sequence: the plan one call returns is the plan the next call must send.
 */
export interface DegreePlanDto {
  Id: number;
  PersonId: string;
  Version: number;
  Terms: { TermId: string; PlannedCourses: PlannedCourseDto[] }[];
  NonTermPlannedCourses?: PlannedCourseDto[];
  [key: string]: unknown;
}

/**
 * The plan as Self-Service renders it: the DTO plus everything the page needs
 * around it.
 *
 * Worth naming separately, because the endpoints disagree about how to hand it
 * over. `Current` wraps it in a `DegreePlan` property alongside the student's
 * programs; every write returns this object bare. Reading one shape where the
 * other arrived is how a successful write reports itself as a failure.
 */
export interface DegreePlanView {
  PersonId: string;
  Id: number;
  Version: number;
  DegreePlanDto: DegreePlanDto;
  /** Terms on the plan, in Colleague's own order. */
  Terms: { Code: string; Description: string; IsTermProtected?: boolean }[];
  /** Terms the plan could be extended with — where the summers live. */
  UnplannedTerms?: { Code: string }[] | string[];
  AvailablePlanningTerms?: { Code: string }[] | string[];
  IsPlanProtected?: boolean;
}

export interface DegreePlanResponse {
  DegreePlan: DegreePlanView;
  StudentPrograms: { Code: string; Title: string; Catalog: string; StudentId: string }[];
}

export interface SearchCriteria {
  keyword: string;
  terms: string[];
  subjects: string[];
  courseIds: string[];
  sectionIds: string[];
  days: string[];
  faculty: string[];
  locations: string[];
  academicLevels: string[];
  courseLevels: string[];
  /** Minutes since midnight. */
  startTime: number;
  endTime: number;
  openSections: boolean;
  openAndWaitlistedSections: boolean;
  pageNumber: number;
  quantityPerPage: number;
  searchResultsView: string;
}

export interface SearchResponse {
  Courses: (CourseRef & { MatchingSectionIds: string[]; MinimumCredits: number })[];
  TotalItems: number;
  TotalPages: number;
  CurrentPageIndex: number;
  Subjects: Facet[];
  TermFilters: Facet[];
  Faculty: Facet[];
  DaysOfWeek: Facet[];
}

export interface Meeting {
  /** Sometimes names ("Monday"), sometimes 0-6 integers, depending on endpoint. */
  Days: (string | number)[] | null;
  StartTime: string | null;
  EndTime: string | null;
  StartDate: string;
  EndDate: string;
  Room: string;
  Frequency: string;
  IsOnline: boolean;
  InstructionalMethodCode: string;
}

export interface FormattedMeeting extends Meeting {
  BuildingDisplay: string;
  RoomDisplay: string;
  DaysOfWeekDisplay: string;
  StartTimeDisplay: string;
  EndTimeDisplay: string;
  DatesDisplay: string;
}

export interface Section {
  Id: string;
  CourseId: string;
  CourseName: string;
  Number: string;
  Title: string;
  Synonym: string;
  TermId: string;
  MinimumCredits: number;
  MaximumCredits: number | null;
  Capacity: number;
  Enrolled: number;
  Available: number;
  Waitlisted: number;
  AvailabilityStatus: string;
  IsNonStandardDates: boolean;
  StartDate: string;
  EndDate: string;
  Meetings: Meeting[];
  /** The display half, which carries times when the structured ones are null. */
  FormattedMeetingTimes: FormattedMeeting[];
}

export interface SectionsResponse {
  SectionsRetrieved: {
    Course: CourseRef;
    TermsAndSections: {
      Term: { Code: string; Description: string };
      Sections: {
        Section: Section;
        FacultyDisplay: string;
        InstructorDetails: { FacultyId: string; FacultyName: string }[];
      }[];
    }[];
  };
}
