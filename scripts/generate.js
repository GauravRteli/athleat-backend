const {
    Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
    Header, Footer, AlignmentType, HeadingLevel, BorderStyle, WidthType,
    ShadingType, VerticalAlign, LevelFormat, PageBreak,
    TabStopType, TabStopPosition, SimpleField
  } = require('docx');
  const fs = require('fs');
  
  // Color palette
  const BRAND_BLUE = "1B3F6E";
  const ACCENT_BLUE = "2563EB";
  const LIGHT_BLUE = "DBEAFE";
  const MEDIUM_BLUE = "93C5FD";
  const DARK_TEXT = "1E293B";
  const MID_TEXT = "475569";
  const LIGHT_BG = "F1F5F9";
  const WHITE = "FFFFFF";
  const GREEN = "16A34A";
  const LIGHT_GREEN = "DCFCE7";
  const PURPLE = "7C3AED";
  const LIGHT_PURPLE = "EDE9FE";
  const ORANGE = "EA580C";
  const LIGHT_ORANGE = "FFEDD5";
  
  const border = { style: BorderStyle.SINGLE, size: 1, color: "CBD5E1" };
  const borders = { top: border, bottom: border, left: border, right: border };
  const noBorders = {
    top: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
    bottom: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
    left: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
    right: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
  };
  
  function sectionTitle(text, color = BRAND_BLUE) {
    return new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 400, after: 160 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: ACCENT_BLUE, space: 6 } },
      children: [
        new TextRun({ text, bold: true, color, font: "Arial", size: 36 })
      ]
    });
  }
  
  function subTitle(text) {
    return new Paragraph({
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 280, after: 120 },
      children: [
        new TextRun({ text, bold: true, color: ACCENT_BLUE, font: "Arial", size: 28 })
      ]
    });
  }
  
  function bulletItem(text, subText = null) {
    const children = [new TextRun({ text, font: "Arial", size: 22, color: DARK_TEXT })];
    if (subText) {
      children.push(new TextRun({ text: `  —  ${subText}`, font: "Arial", size: 20, color: MID_TEXT, italics: true }));
    }
    return new Paragraph({
      numbering: { reference: "bullets", level: 0 },
      spacing: { before: 60, after: 60 },
      children
    });
  }
  
  function subBulletItem(text) {
    return new Paragraph({
      numbering: { reference: "subbullets", level: 0 },
      spacing: { before: 40, after: 40 },
      children: [new TextRun({ text, font: "Arial", size: 20, color: MID_TEXT })]
    });
  }
  
  function bodyText(text, bold = false) {
    return new Paragraph({
      spacing: { before: 80, after: 80 },
      children: [new TextRun({ text, font: "Arial", size: 22, color: DARK_TEXT, bold })]
    });
  }
  
  function space(sz = 120) {
    return new Paragraph({ spacing: { before: sz, after: 0 }, children: [new TextRun("")] });
  }
  
  function highlightBox(label, text, bgColor, labelColor) {
    return new Table({
      width: { size: 9360, type: WidthType.DXA },
      columnWidths: [1440, 7920],
      rows: [
        new TableRow({
          children: [
            new TableCell({
              borders: noBorders,
              width: { size: 1440, type: WidthType.DXA },
              shading: { fill: bgColor, type: ShadingType.CLEAR },
              margins: { top: 100, bottom: 100, left: 160, right: 100 },
              verticalAlign: VerticalAlign.CENTER,
              children: [new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: label, font: "Arial", size: 18, bold: true, color: labelColor })]
              })]
            }),
            new TableCell({
              borders: noBorders,
              width: { size: 7920, type: WidthType.DXA },
              shading: { fill: bgColor, type: ShadingType.CLEAR },
              margins: { top: 100, bottom: 100, left: 160, right: 160 },
              children: [new Paragraph({
                children: [new TextRun({ text, font: "Arial", size: 21, color: DARK_TEXT })]
              })]
            })
          ]
        })
      ]
    });
  }
  
  function featureTable(rows, col1Width = 2800, col2Width = 6560) {
    const tableRows = [
      new TableRow({
        tableHeader: true,
        children: [
          new TableCell({
            borders,
            width: { size: col1Width, type: WidthType.DXA },
            shading: { fill: BRAND_BLUE, type: ShadingType.CLEAR },
            margins: { top: 100, bottom: 100, left: 140, right: 120 },
            children: [new Paragraph({ children: [new TextRun({ text: "Feature", font: "Arial", size: 22, bold: true, color: WHITE })] })]
          }),
          new TableCell({
            borders,
            width: { size: col2Width, type: WidthType.DXA },
            shading: { fill: BRAND_BLUE, type: ShadingType.CLEAR },
            margins: { top: 100, bottom: 100, left: 140, right: 120 },
            children: [new Paragraph({ children: [new TextRun({ text: "Description", font: "Arial", size: 22, bold: true, color: WHITE })] })]
          })
        ]
      }),
      ...rows.map(([feat, desc], i) => new TableRow({
        children: [
          new TableCell({
            borders,
            width: { size: col1Width, type: WidthType.DXA },
            shading: { fill: i % 2 === 0 ? WHITE : LIGHT_BG, type: ShadingType.CLEAR },
            margins: { top: 90, bottom: 90, left: 140, right: 120 },
            children: [new Paragraph({ children: [new TextRun({ text: feat, font: "Arial", size: 21, bold: true, color: ACCENT_BLUE })] })]
          }),
          new TableCell({
            borders,
            width: { size: col2Width, type: WidthType.DXA },
            shading: { fill: i % 2 === 0 ? WHITE : LIGHT_BG, type: ShadingType.CLEAR },
            margins: { top: 90, bottom: 90, left: 140, right: 120 },
            children: [new Paragraph({ children: [new TextRun({ text: desc, font: "Arial", size: 21, color: DARK_TEXT })] })]
          })
        ]
      }))
    ];
    return new Table({ width: { size: 9360, type: WidthType.DXA }, columnWidths: [col1Width, col2Width], rows: tableRows });
  }
  
  function moduleCard(title, items, bg, titleColor) {
    const cellChildren = [
      new Paragraph({
        spacing: { before: 0, after: 100 },
        children: [new TextRun({ text: title, font: "Arial", size: 24, bold: true, color: titleColor })]
      }),
      ...items.map(item => new Paragraph({
        numbering: { reference: "bullets", level: 0 },
        spacing: { before: 50, after: 50 },
        children: [new TextRun({ text: item, font: "Arial", size: 20, color: DARK_TEXT })]
      }))
    ];
    return new Table({
      width: { size: 9360, type: WidthType.DXA },
      columnWidths: [9360],
      rows: [new TableRow({
        children: [new TableCell({
          borders,
          width: { size: 9360, type: WidthType.DXA },
          shading: { fill: bg, type: ShadingType.CLEAR },
          margins: { top: 160, bottom: 160, left: 200, right: 200 },
          children: cellChildren
        })]
      })]
    });
  }
  
  // --- Cover Page ---
  function makeCoverPage() {
    return [
      space(1200),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 60 },
        children: [new TextRun({ text: "CA CRM", font: "Arial", size: 80, bold: true, color: BRAND_BLUE })]
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 200 },
        children: [new TextRun({ text: "Chartered Accountant Practice Management System", font: "Arial", size: 32, color: ACCENT_BLUE, italics: true })]
      }),
      new Table({
        width: { size: 9360, type: WidthType.DXA },
        columnWidths: [9360],
        rows: [new TableRow({
          children: [new TableCell({
            borders: noBorders,
            width: { size: 9360, type: WidthType.DXA },
            shading: { fill: BRAND_BLUE, type: ShadingType.CLEAR },
            margins: { top: 240, bottom: 240, left: 360, right: 360 },
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: "Complete End-to-End CRM Solution for CA Firms", font: "Arial", size: 30, bold: true, color: WHITE })]
              }),
              new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { before: 100 },
                children: [new TextRun({ text: "Recurring Services  •  Client Management  •  Document Management  •  Invoicing  •  WhatsApp Integration  •  Mobile App", font: "Arial", size: 20, color: MEDIUM_BLUE })]
              })
            ]
          })]
        })]
      }),
      space(400),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: "Product Features & Capabilities Documentation", font: "Arial", size: 24, color: MID_TEXT })]
      }),
      space(200),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: "Version 1.0  |  2025", font: "Arial", size: 20, color: MID_TEXT })]
      }),
      new Paragraph({ children: [new PageBreak()] })
    ];
  }
  
  const doc = new Document({
    numbering: {
      config: [
        {
          reference: "bullets",
          levels: [{
            level: 0, format: LevelFormat.BULLET, text: "\u2022",
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 560, hanging: 280 } } }
          }]
        },
        {
          reference: "subbullets",
          levels: [{
            level: 0, format: LevelFormat.BULLET, text: "\u25E6",
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 1000, hanging: 280 } } }
          }]
        }
      ]
    },
    styles: {
      default: { document: { run: { font: "Arial", size: 22 } } },
      paragraphStyles: [
        {
          id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { size: 36, bold: true, font: "Arial", color: BRAND_BLUE },
          paragraph: { spacing: { before: 360, after: 160 }, outlineLevel: 0 }
        },
        {
          id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { size: 28, bold: true, font: "Arial", color: ACCENT_BLUE },
          paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 1 }
        }
      ]
    },
    sections: [{
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 }
        }
      },
      headers: {
        default: new Header({
          children: [
            new Table({
              width: { size: 10080, type: WidthType.DXA },
              columnWidths: [5040, 5040],
              rows: [new TableRow({
                children: [
                  new TableCell({
                    borders: noBorders,
                    width: { size: 5040, type: WidthType.DXA },
                    margins: { top: 60, bottom: 60, left: 0, right: 0 },
                    children: [new Paragraph({
                      children: [new TextRun({ text: "CA CRM — Product Documentation", font: "Arial", size: 18, bold: true, color: BRAND_BLUE })]
                    })]
                  }),
                  new TableCell({
                    borders: noBorders,
                    width: { size: 5040, type: WidthType.DXA },
                    margins: { top: 60, bottom: 60, left: 0, right: 0 },
                    children: [new Paragraph({
                      alignment: AlignmentType.RIGHT,
                      children: [new TextRun({ text: "Chartered Accountant Practice Management", font: "Arial", size: 18, color: MID_TEXT })]
                    })]
                  })
                ]
              })]
            }),
            new Paragraph({
              border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: ACCENT_BLUE, space: 4 } },
              children: [new TextRun("")]
            })
          ]
        })
      },
      footers: {
        default: new Footer({
          children: [
            new Paragraph({
              border: { top: { style: BorderStyle.SINGLE, size: 4, color: "CBD5E1", space: 4 } },
              children: [new TextRun("")]
            }),
            new Paragraph({
              tabStops: [{ type: TabStopType.RIGHT, position: 9000 }],
              children: [
                new TextRun({ text: "Confidential — CA CRM Product Documentation", font: "Arial", size: 18, color: MID_TEXT }),
                new TextRun({ text: "\tPage ", font: "Arial", size: 18, color: MID_TEXT }),
                new SimpleField("PAGE")
              ]
            })
          ]
        })
      },
      children: [
        // COVER PAGE
        ...makeCoverPage(),
  
        // SECTION 1 — EXECUTIVE SUMMARY
        sectionTitle("1. Executive Summary"),
        bodyText("CA CRM is a comprehensive, all-in-one practice management platform specifically designed for Chartered Accountant firms in India. It streamlines every aspect of a CA firm's operations — from client onboarding and recurring compliance task automation to document management, billing, employee management, and real-time WhatsApp communication."),
        space(100),
        bodyText("Built with deep domain knowledge of the CA profession, CA CRM eliminates manual tracking, reduces administrative overhead, and ensures that no compliance deadline is ever missed — all from a single unified platform available on both web and mobile."),
        space(120),
  
        new Table({
          width: { size: 9360, type: WidthType.DXA },
          columnWidths: [3120, 3120, 3120],
          rows: [
            new TableRow({
              children: [
                new TableCell({
                  borders,
                  width: { size: 3120, type: WidthType.DXA },
                  shading: { fill: BRAND_BLUE, type: ShadingType.CLEAR },
                  margins: { top: 160, bottom: 160, left: 160, right: 160 },
                  children: [
                    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "10+ Modules", font: "Arial", size: 36, bold: true, color: WHITE })] }),
                    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "Fully Integrated", font: "Arial", size: 20, color: MEDIUM_BLUE })] })
                  ]
                }),
                new TableCell({
                  borders,
                  width: { size: 3120, type: WidthType.DXA },
                  shading: { fill: ACCENT_BLUE, type: ShadingType.CLEAR },
                  margins: { top: 160, bottom: 160, left: 160, right: 160 },
                  children: [
                    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "100% WhatsApp", font: "Arial", size: 36, bold: true, color: WHITE })] }),
                    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "Integrated", font: "Arial", size: 20, color: LIGHT_BLUE })] })
                  ]
                }),
                new TableCell({
                  borders,
                  width: { size: 3120, type: WidthType.DXA },
                  shading: { fill: GREEN, type: ShadingType.CLEAR },
                  margins: { top: 160, bottom: 160, left: 160, right: 160 },
                  children: [
                    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "Web + Mobile", font: "Arial", size: 36, bold: true, color: WHITE })] }),
                    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "Full Feature Parity", font: "Arial", size: 20, color: LIGHT_GREEN })] })
                  ]
                })
              ]
            })
          ]
        }),
        space(200),
        new Paragraph({ children: [new PageBreak()] }),
  
        // SECTION 2 — MODULE OVERVIEW
        sectionTitle("2. Core Modules at a Glance"),
        bodyText("CA CRM is organized into the following key modules, each designed to address a specific area of a CA firm's operations:"),
        space(120),
  
        featureTable([
          ["Recurring Services", "Automate task/work order creation for GST filings, ITR, ROC, TDS, and all periodic compliance services"],
          ["Client Management", "Centralized client profiles with contact info, service history, tags, and communication logs"],
          ["Document Management", "Hierarchical file explorer for organizing, uploading, and retrieving client documents by category"],
          ["Invoicing & Billing", "Auto-generate invoices, record payments, and issue receipts with one click"],
          ["Revenue Analytics", "Real-time dashboards and reports on revenue, collections, outstanding, and service-wise performance"],
          ["Document Registry", "Inward and outward document movement tracking with timestamps and acknowledgement"],
          ["Employee Management", "Staff profiles, attendance, leave management, check-in/check-out, and performance tracking"],
          ["Visitor / Reception", "Client visitor entry log for the front desk/receptionist with timestamped records"],
          ["Portal Credentials", "Secure storage and management of client credentials for GST portal, Income Tax portal, and more"],
          ["WhatsApp Integration", "End-to-end automated WhatsApp messaging for invoices, receipts, reminders, approvals, and flows"],
          ["WhatsApp Flows", "Interactive client-facing WhatsApp flows for credential retrieval and document access on demand"],
          ["Browser Extension", "Auto-fill client portal credentials directly into GST/IT portals from CRM data"],
          ["Mobile Application", "Full-featured mobile app mirroring all web CRM capabilities for on-the-go access"],
        ]),
        space(200),
        new Paragraph({ children: [new PageBreak()] }),
  
        // SECTION 3 — RECURRING SERVICES
        sectionTitle("3. Recurring Services & Work Order Automation"),
        bodyText("One of the most powerful capabilities of CA CRM is its intelligent recurring services engine. Instead of manually creating tasks for every client every month, the system automatically generates work orders based on predefined schedules — eliminating oversight and ensuring complete compliance coverage."),
        space(120),
        subTitle("3.1 How Recurring Service Automation Works"),
        bulletItem("Service Scheduling", "Define recurring frequencies — monthly, quarterly, half-yearly, or annually — per service per client"),
        bulletItem("Automatic Work Order Creation", "On the due date, the system auto-generates a task/work order assigned to the responsible staff member"),
        bulletItem("GST Return Filing (GSTR-1, GSTR-3B)", "Monthly work orders auto-created for every GST-registered client"),
        bulletItem("Income Tax Return Filing", "Annual work orders with reminders based on assessment year and client type"),
        bulletItem("TDS Return Filing", "Quarterly work orders for TDS compliance"),
        bulletItem("ROC Filings / Annual Compliance", "Scheduled work orders for company annual filings"),
        bulletItem("Custom Services", "Add any firm-specific recurring service with custom frequency and billing"),
        space(120),
        subTitle("3.2 Work Order Management"),
        bulletItem("Status Tracking", "Each work order moves through stages: Pending → In Progress → Review → Completed"),
        bulletItem("Staff Assignment", "Auto-assign or manually reassign work orders to team members"),
        bulletItem("Priority & Deadlines", "Set deadlines with colour-coded priority indicators"),
        bulletItem("Bulk View", "View all pending work orders across all clients in a single dashboard"),
        bulletItem("Client-wise History", "Full history of completed and pending work orders per client"),
        space(200),
        new Paragraph({ children: [new PageBreak()] }),
  
        // SECTION 4 — CLIENT MANAGEMENT
        sectionTitle("4. Client Management"),
        bodyText("CA CRM provides a comprehensive 360-degree view of every client in the firm. All information, services, documents, credentials, invoices, and communication history are accessible from a single client profile."),
        space(120),
        subTitle("4.1 Client Profile"),
        bulletItem("Complete KYC Details", "PAN, Aadhaar, GSTIN, CIN, address, contact persons, and more"),
        bulletItem("Client Categorization", "Segment clients by type: Individual, Proprietorship, Partnership, LLP, Company, Trust, etc."),
        bulletItem("Service Subscription", "Track which services each client has subscribed to"),
        bulletItem("Communication Log", "Full history of all WhatsApp messages, emails, and calls related to the client"),
        bulletItem("Notes & Remarks", "Internal notes visible only to staff for client-specific guidance"),
        bulletItem("Tags & Filters", "Tag clients for quick filtering and bulk actions"),
        space(120),
        subTitle("4.2 Portal Credential Management"),
        bodyText("Every client has multiple government portal credentials that staff need to access regularly. CA CRM securely stores and manages all of them in one place:"),
        space(80),
        bulletItem("GST Portal", "Username and password stored securely against each client"),
        bulletItem("Income Tax Portal (e-Filing)", "Login credentials for income tax return filing"),
        bulletItem("Traces Portal", "Credentials for TDS reconciliation"),
        bulletItem("MCA / ROC Portal", "Ministry of Corporate Affairs login details"),
        bulletItem("Other Custom Portals", "Add any additional portal credentials as needed"),
        space(120),
        subTitle("4.3 WhatsApp Flow — Client Self-Service for Credentials & Documents"),
        bodyText("To reduce the daily overhead of staff answering credential requests, CA CRM provides an automated WhatsApp Flow that clients can use any time:"),
        space(80),
        bulletItem("Credential Retrieval Flow", "Client initiates flow → selects portal type → receives credentials instantly via WhatsApp without staff intervention"),
        bulletItem("Document Retrieval Flow", "Client selects financial year → receives requested documents on WhatsApp automatically"),
        bulletItem("Button-Based Navigation", "All flows are driven by easy tap-to-respond buttons, no typing required"),
        bulletItem("24/7 Availability", "Clients get self-service access round the clock without depending on office hours"),
        space(200),
        new Paragraph({ children: [new PageBreak()] }),
  
        // SECTION 5 — DOCUMENT MANAGEMENT
        sectionTitle("5. Document Management System"),
        bodyText("CA CRM features a fully-featured document management system that mimics a file explorer interface, providing a structured, intuitive way to store and retrieve client documents."),
        space(120),
        subTitle("5.1 File Explorer Interface"),
        bulletItem("Hierarchical Folder Structure", "Organize documents in nested folders by client, financial year, document type, and sub-category"),
        bulletItem("Drag & Drop Upload", "Easily upload single or multiple documents with drag-and-drop support"),
        bulletItem("Rename, Move & Delete", "Full file management operations just like a desktop file explorer"),
        bulletItem("Preview Support", "Preview PDFs, images, and common document types directly in the browser"),
        bulletItem("Search & Filter", "Search documents by name, date, type, or client across the entire document library"),
        space(120),
        subTitle("5.2 Document Organization"),
        bulletItem("Financial Year Grouping", "Documents automatically organized by FY for easy retrieval during audits"),
        bulletItem("Document Type Tags", "Tag documents as Returns, Certificates, Agreements, Invoices, Workings, etc."),
        bulletItem("Version Control", "Maintain multiple versions of the same document without overwriting"),
        bulletItem("Access Control", "Restrict document access by role — staff can only see relevant client documents"),
        space(120),
        subTitle("5.3 Document Inward & Outward Registry"),
        bodyText("CA CRM maintains a complete physical document movement register for the firm:"),
        space(80),
        bulletItem("Inward Registry", "Log every document received from clients with sender, date, description, and recipient"),
        bulletItem("Outward Registry", "Track every document sent out to clients or third parties with tracking details"),
        bulletItem("Timestamped Records", "All entries are auto-timestamped for audit trail purposes"),
        bulletItem("Acknowledgement Tracking", "Mark documents as acknowledged/delivered and track outstanding returns"),
        bulletItem("Reports", "Generate inward/outward registers for any date range in printable format"),
        space(200),
        new Paragraph({ children: [new PageBreak()] }),
  
        // SECTION 6 — INVOICING & FINANCE
        sectionTitle("6. Invoicing, Payments & Financial Management"),
        bodyText("CA CRM automates the complete billing lifecycle — from invoice generation to payment collection and receipt issuance — with built-in WhatsApp delivery and comprehensive revenue analytics."),
        space(120),
        subTitle("6.1 Invoice Management"),
        bulletItem("Auto Invoice Generation", "Invoices auto-created on service completion or on a scheduled billing date"),
        bulletItem("Custom Line Items", "Add service descriptions, HSN/SAC codes, GST rates, and discounts"),
        bulletItem("GST Compliant", "All invoices are GST-compliant with CGST/SGST/IGST breakup"),
        bulletItem("Invoice Numbering", "Auto-sequential invoice numbering with customizable prefix"),
        bulletItem("Invoice Preview & PDF", "Generate print-ready PDF invoices with firm letterhead"),
        bulletItem("WhatsApp Delivery", "Share invoices instantly on WhatsApp to the client with one click"),
        space(120),
        subTitle("6.2 Payment Recording & Receipts"),
        bulletItem("Payment Entry", "Record full or partial payments against any invoice"),
        bulletItem("Multiple Payment Modes", "Support for cash, cheque, NEFT/RTGS, UPI, and other modes"),
        bulletItem("Automatic Receipt Generation", "Receipt auto-generated on payment recording"),
        bulletItem("WhatsApp Receipt", "Payment receipts instantly shared on WhatsApp to the client"),
        bulletItem("Outstanding Tracking", "Real-time view of unpaid and partially paid invoices per client"),
        space(120),
        subTitle("6.3 Payment Reminders"),
        bulletItem("Due Date Based Reminders", "Automated daily WhatsApp reminders sent to clients with overdue invoices"),
        bulletItem("Custom Reminder Templates", "Personalized reminder message templates with client name and amount"),
        bulletItem("Reminder Logs", "Track which reminders have been sent and when"),
        space(120),
        subTitle("6.4 Revenue Analytics & Reports"),
        bulletItem("Revenue Dashboard", "Real-time overview of total billed, collected, and outstanding amounts"),
        bulletItem("Monthly / Quarterly Reports", "Period-wise revenue breakdowns with charts"),
        bulletItem("Service-wise Revenue", "Understand which services generate the most revenue"),
        bulletItem("Client-wise Revenue", "Identify top clients by billing value"),
        bulletItem("Collection Efficiency", "Track payment conversion rates and ageing analysis"),
        bulletItem("Export to Excel / PDF", "Export all reports for external use or filing"),
        space(200),
        new Paragraph({ children: [new PageBreak()] }),
  
        // SECTION 7 — EMPLOYEE MANAGEMENT
        sectionTitle("7. Employee & HR Management"),
        bodyText("CA CRM includes a complete HR module enabling CA firms to manage their team, track attendance, handle leaves, and monitor daily check-ins — all within the same platform."),
        space(120),
        subTitle("7.1 Employee Profiles"),
        bulletItem("Staff Directory", "Complete profiles with designation, department, contact, and joining date"),
        bulletItem("Role-Based Access", "Each employee gets access only to features and clients relevant to their role"),
        bulletItem("Performance Notes", "Internal notes and performance tracking per employee"),
        space(120),
        subTitle("7.2 Attendance Management"),
        bulletItem("Daily Attendance Marking", "Staff can mark attendance daily via web or mobile app"),
        bulletItem("Attendance Register", "Monthly attendance register with present, absent, and leave details"),
        bulletItem("Attendance Reports", "Generate attendance summaries for payroll processing"),
        space(120),
        subTitle("7.3 Leave Management"),
        bulletItem("Leave Application", "Staff apply for leaves via the mobile app or web portal"),
        bulletItem("Leave Approval Workflow", "Managers approve or reject leave requests with optional comments"),
        bulletItem("WhatsApp Notification", "Employees receive instant WhatsApp notification of leave approval or rejection"),
        bulletItem("Leave Balance Tracking", "Casual, earned, and sick leave balances tracked automatically"),
        bulletItem("Leave Calendar", "Visual calendar showing team availability and planned leaves"),
        space(120),
        subTitle("7.4 Check-In / Check-Out System"),
        bulletItem("Client Visit Logging", "Staff record check-in when visiting a client's premises"),
        bulletItem("WhatsApp Notifications", "Client receives automatic WhatsApp message when staff checks in and checks out"),
        bulletItem("GPS / Time Stamp", "Each check-in and check-out is timestamped for accountability"),
        bulletItem("Visit History", "Complete visit history per client and per employee"),
        space(200),
        new Paragraph({ children: [new PageBreak()] }),
  
        // SECTION 8 — RECEPTION & VISITOR MANAGEMENT
        sectionTitle("8. Reception & Visitor Management"),
        bodyText("CA CRM provides a dedicated visitor management module for the front desk. Receptionists can quickly log client walk-ins and outgoing visitors, creating a structured visitor register."),
        space(120),
        bulletItem("Client Visitor Entry", "Log arriving visitors with name, contact, purpose of visit, and meeting person"),
        bulletItem("Check-In Timestamp", "Automatic time-stamping of visitor arrival"),
        bulletItem("Check-Out Logging", "Record visitor departure time"),
        bulletItem("WhatsApp Notification", "Notify the concerned staff member via WhatsApp when their visitor arrives"),
        bulletItem("Visitor Register", "Searchable digital register of all visitors by date, client, or purpose"),
        bulletItem("Walk-In Client Logging", "Log unscheduled client visits for reference"),
        space(200),
        new Paragraph({ children: [new PageBreak()] }),
  
        // SECTION 9 — WHATSAPP INTEGRATION
        sectionTitle("9. WhatsApp Integration — End-to-End Communication"),
        bodyText("WhatsApp is deeply integrated throughout CA CRM, turning every important event into an instant, professional communication to clients and staff. There is no need for separate messaging — everything is automatic."),
        space(120),
        featureTable([
          ["Invoice Generated", "Automatically share the invoice PDF on WhatsApp to the client immediately upon generation"],
          ["Receipt Generated", "Payment receipt instantly delivered to client on WhatsApp when payment is recorded"],
          ["Check-In Message", "Client receives a WhatsApp message when a staff member checks in for a visit"],
          ["Check-Out Message", "Check-out confirmation WhatsApp sent to client with visit duration summary"],
          ["Leave Approval/Rejection", "Employee receives WhatsApp notification of their leave request decision instantly"],
          ["Payment Reminders", "Daily automated reminders for overdue invoices sent to clients via WhatsApp"],
          ["Work Order Updates", "Staff notified on WhatsApp for new or reassigned work orders"],
          ["Document Dispatch", "WhatsApp notification when documents are dispatched to clients"],
          ["Visitor Notification", "Front desk can WhatsApp staff when their client/visitor has arrived"],
        ]),
        space(160),
        subTitle("9.1 WhatsApp Flows — Interactive Self-Service"),
        bodyText("Beyond one-way notifications, CA CRM features WhatsApp Flows — interactive, button-driven conversations that allow clients to request information on their own, without calling the office:"),
        space(80),
        bulletItem("Portal Credential Flow", "Client navigates through options and receives their GST or Income Tax login credentials on WhatsApp instantly"),
        bulletItem("Document Request Flow", "Client selects the financial year and document type and receives the file on WhatsApp"),
        bulletItem("Button-Based Interface", "All interactions happen through simple buttons — no typing required from the client"),
        bulletItem("Zero Staff Overhead", "Once set up, flows run completely automatically, eliminating repetitive credential and document queries"),
        bulletItem("24/7 Availability", "Clients can access credentials and documents any time, even outside office hours"),
        space(200),
        new Paragraph({ children: [new PageBreak()] }),
  
        // SECTION 10 — BROWSER EXTENSION
        sectionTitle("10. Browser Extension — Auto Portal Login"),
        bodyText("CA CRM includes a powerful browser extension that bridges the CRM's stored credentials directly with government tax portals. This eliminates the repetitive process of looking up a client's login details and manually typing them into the portal."),
        space(120),
        subTitle("10.1 How It Works"),
        bulletItem("Install Extension", "One-time installation of the CA CRM extension in Chrome or compatible browsers"),
        bulletItem("Client Selection", "Staff selects the client name from the CRM extension popup"),
        bulletItem("Auto-Fill Credentials", "Extension automatically fills the username and password fields on the GST portal or Income Tax portal"),
        bulletItem("One-Click Login", "Staff click Login — no manual typing required"),
        space(120),
        subTitle("10.2 Supported Portals"),
        bulletItem("GST Portal", "gstin.gov.in — auto-fill GSTIN-based login credentials"),
        bulletItem("Income Tax e-Filing Portal", "incometax.gov.in — auto-fill PAN-based login"),
        bulletItem("Traces Portal", "traces.gov.in — auto-fill for TDS reconciliation"),
        bulletItem("MCA / ROC Portal", "mca.gov.in — auto-fill company login"),
        bulletItem("Expandable", "New portals can be added as needed"),
        space(120),
        subTitle("10.3 Business Value"),
  
        new Table({
          width: { size: 9360, type: WidthType.DXA },
          columnWidths: [4680, 4680],
          rows: [
            new TableRow({
              children: [
                new TableCell({
                  borders,
                  width: { size: 4680, type: WidthType.DXA },
                  shading: { fill: LIGHT_BG, type: ShadingType.CLEAR },
                  margins: { top: 120, bottom: 120, left: 160, right: 160 },
                  children: [
                    new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: "Without Extension", font: "Arial", size: 22, bold: true, color: ORANGE })] }),
                    new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun({ text: "Open CRM to find credentials", font: "Arial", size: 21, color: DARK_TEXT })] }),
                    new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun({ text: "Manually type on portal login page", font: "Arial", size: 21, color: DARK_TEXT })] }),
                    new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun({ text: "Risk of typo errors", font: "Arial", size: 21, color: DARK_TEXT })] }),
                    new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun({ text: "Repeated for every client, every day", font: "Arial", size: 21, color: DARK_TEXT })] }),
                  ]
                }),
                new TableCell({
                  borders,
                  width: { size: 4680, type: WidthType.DXA },
                  shading: { fill: LIGHT_GREEN, type: ShadingType.CLEAR },
                  margins: { top: 120, bottom: 120, left: 160, right: 160 },
                  children: [
                    new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: "With CA CRM Extension", font: "Arial", size: 22, bold: true, color: GREEN })] }),
                    new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun({ text: "Select client from extension popup", font: "Arial", size: 21, color: DARK_TEXT })] }),
                    new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun({ text: "Credentials auto-filled instantly", font: "Arial", size: 21, color: DARK_TEXT })] }),
                    new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun({ text: "Zero errors, zero effort", font: "Arial", size: 21, color: DARK_TEXT })] }),
                    new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun({ text: "Saves hours every week for the team", font: "Arial", size: 21, color: DARK_TEXT })] }),
                  ]
                })
              ]
            })
          ]
        }),
        space(200),
        new Paragraph({ children: [new PageBreak()] }),
  
        // SECTION 11 — MOBILE APP
        sectionTitle("11. Mobile Application"),
        bodyText("CA CRM is not just a web product. A full-featured mobile application is available for both iOS and Android, giving team members and administrators access to the complete CRM from anywhere, at any time."),
        space(120),
        bodyText("Every feature available on the web is also available on mobile:", true),
        space(80),
        bulletItem("Dashboard & Overview", "Real-time summary of tasks, pending work orders, revenue, and notifications"),
        bulletItem("Client Management", "Access and update client profiles, contact details, and service lists"),
        bulletItem("Work Order Management", "View, update, and close work orders from the field"),
        bulletItem("Document Access", "View and download client documents on the go"),
        bulletItem("Invoice & Payment", "Create invoices, record payments, and share receipts via WhatsApp from mobile"),
        bulletItem("Attendance Marking", "Daily attendance marking from the mobile app"),
        bulletItem("Leave Application", "Apply for leave and check approval status from mobile"),
        bulletItem("Check-In / Check-Out", "Staff can check in and out of client visits via mobile"),
        bulletItem("Visitor Entry", "Reception staff can log visitors from the mobile app"),
        bulletItem("WhatsApp Shortcuts", "Quick WhatsApp share buttons for invoices, receipts, and documents"),
        bulletItem("Push Notifications", "Real-time alerts for new tasks, payments, leave approvals, and more"),
        space(200),
        new Paragraph({ children: [new PageBreak()] }),
  
        // SECTION 12 — SUMMARY TABLE
        sectionTitle("12. Complete Feature Summary"),
        space(80),
        featureTable([
          ["Recurring Work Orders", "Auto-creation of GST, ITR, TDS, ROC, and custom service tasks for every client"],
          ["Work Order Tracking", "Status management from creation to completion with staff assignment"],
          ["Client 360 Profile", "PAN, GSTIN, contacts, services, history, notes, and documents in one place"],
          ["Portal Credentials Store", "Secure storage of GST, IT, Traces, MCA portal logins per client"],
          ["File Explorer DMS", "Hierarchical document storage with preview, search, and version control"],
          ["Inward Registry", "Log all documents received from clients with full audit trail"],
          ["Outward Registry", "Track all documents dispatched to clients or third parties"],
          ["Auto Invoicing", "GST-compliant invoice auto-generation on service completion or schedule"],
          ["Payment Recording", "Partial/full payment entry with automatic receipt generation"],
          ["WhatsApp Invoice Share", "One-click WhatsApp delivery of invoice PDF to client"],
          ["WhatsApp Receipt Share", "Automatic WhatsApp delivery of payment receipt"],
          ["Payment Reminders", "Daily automated WhatsApp reminders for overdue payments"],
          ["Revenue Dashboard", "Real-time analytics on billing, collections, and outstanding"],
          ["Service/Client Reports", "Revenue breakdowns by service type and client"],
          ["Employee Profiles", "Staff directory with roles, access control, and designations"],
          ["Attendance Management", "Daily attendance register with monthly reports"],
          ["Leave Management", "Leave application, approval workflow, and balance tracking"],
          ["Leave WhatsApp Alerts", "Instant WhatsApp notification of leave approval / rejection"],
          ["Check-In / Check-Out", "Client visit logging with WhatsApp alerts to client"],
          ["Visitor Management", "Reception-side visitor entry log with staff notification"],
          ["WhatsApp Flows", "Interactive client self-service for credentials and documents"],
          ["Browser Extension", "Auto-fill client portal credentials on GST / IT / Traces / MCA portals"],
          ["Mobile App (iOS/Android)", "Full CRM feature parity on mobile for team and management"],
        ]),
        space(200),
        new Paragraph({ children: [new PageBreak()] }),
  
        // SECTION 13 — WHY CA CRM
        sectionTitle("13. Why CA CRM?"),
        space(80),
  
        new Table({
          width: { size: 9360, type: WidthType.DXA },
          columnWidths: [9360],
          rows: [
            new TableRow({
              children: [new TableCell({
                borders: noBorders,
                width: { size: 9360, type: WidthType.DXA },
                shading: { fill: LIGHT_BLUE, type: ShadingType.CLEAR },
                margins: { top: 200, bottom: 200, left: 240, right: 240 },
                children: [
                  new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "Designed exclusively for CA firms. Not a generic CRM adapted for CAs.", font: "Arial", size: 26, bold: true, color: BRAND_BLUE, italics: true })] })
                ]
              })]
            })
          ]
        }),
        space(160),
        bulletItem("Purpose-Built for CAs", "Every module is designed around real CA firm workflows — GST filings, ITR, ROC, client credentials, and compliance tracking"),
        bulletItem("Zero Communication Gap", "100% WhatsApp integration means clients are always informed — invoices, receipts, reminders, credentials, and documents, all on WhatsApp"),
        bulletItem("Massive Time Savings", "Recurring automation + browser extension + WhatsApp flows eliminate hours of repetitive daily work for staff"),
        bulletItem("Client Delight", "Self-service WhatsApp flows allow clients to get what they need instantly, any time, improving satisfaction"),
        bulletItem("Single Platform", "No need for separate tools for billing, HR, documents, tasks, and communication — it's all in CA CRM"),
        bulletItem("Web + Mobile", "Whether in office or in the field, your entire firm runs on CA CRM from any device"),
        bulletItem("Scalable", "Works for a solo CA practice as well as large multi-partner firms with many staff and thousands of clients"),
        space(200),
  
        // CLOSING
        new Table({
          width: { size: 9360, type: WidthType.DXA },
          columnWidths: [9360],
          rows: [new TableRow({
            children: [new TableCell({
              borders: noBorders,
              width: { size: 9360, type: WidthType.DXA },
              shading: { fill: BRAND_BLUE, type: ShadingType.CLEAR },
              margins: { top: 280, bottom: 280, left: 360, right: 360 },
              children: [
                new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "CA CRM", font: "Arial", size: 40, bold: true, color: WHITE })] }),
                new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 80 }, children: [new TextRun({ text: "Empowering CA Firms to Work Smarter", font: "Arial", size: 24, color: LIGHT_BLUE, italics: true })] }),
                new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 140 }, children: [new TextRun({ text: "For inquiries, demos, and onboarding — contact us today.", font: "Arial", size: 22, color: MEDIUM_BLUE })] })
              ]
            })]
          })]
        }),
        space(80),
      ]
    }]
  });
  
  Packer.toBuffer(doc).then(buffer => {
    fs.writeFileSync('CA_CRM_Product_Documentation.docx', buffer);
    console.log('Done!');
  });